import 'dotenv/config';
import { createAgendaProvider } from './agenda/index.js';
import { createAiProvider, createLocalInterpreter, createTranscriber } from './ai/index.js';
import { createApp } from './app.js';
import { Bot } from './bot.js';
import { loadClinic } from './config/clinic.js';
import { loadEnv, missingWhatsAppVars } from './env.js';
import { MemoryHumanPauseStore, MemorySessionStore } from './sessions/store.js';
import { logger } from './util/logger.js';
import { RateLimiter } from './util/rateLimit.js';
import { WhatsAppClient } from './whatsapp/client.js';
import type { MessageSender } from './whatsapp/types.js';

function main(): void {
  const env = loadEnv();
  const clinic = loadClinic(env.CLINIC_CONFIG_PATH);
  const agenda = createAgendaProvider(env, clinic);

  if (env.AGENDA_PROVIDER === 'memory') {
    logger.warn('agenda_en_memoria', { aviso: 'Las citas se pierden al reiniciar. Solo para pruebas.' });
  }

  const aiProvider = createAiProvider(env);

  const aiLocal = createLocalInterpreter(env);
  if (env.AI_PROVIDER === 'gemini') {
    logger.warn('ia_activa', {
      proveedor: 'gemini',
      modelo: env.GEMINI_MODEL,
      aviso: 'Con pacientes reales use un proyecto con facturacion habilitada (nivel de pago); el nivel gratuito es solo para datos ficticios. Vea docs/IA.md.',
    });
  } else if (env.AI_PROVIDER === 'fake') {
    logger.warn('ia_simulada', { aviso: 'AI_PROVIDER=fake es solo para pruebas.' });
  }

  const transcriber = createTranscriber(env);
  if (env.AUDIO_TRANSCRIPTION === 'gemini') {
    logger.warn('audio_activo', {
      modelo: env.GEMINI_MODEL,
      max_segundos: env.AUDIO_MAX_SECONDS,
      aviso: 'Las notas de voz se envian a Gemini solo para transcribirlas. Con pacientes reales use nivel de pago (facturacion habilitada). Vea docs/AUDIO.md.',
    });
  } else if (env.AUDIO_TRANSCRIPTION === 'fake') {
    logger.warn('audio_simulado', { aviso: 'AUDIO_TRANSCRIPTION=fake es solo para pruebas: no transcribe de verdad.' });
  }

  const sessions = new MemorySessionStore(env.SESSION_TTL_MINUTES * 60_000);
  sessions.startSweeper();

  const bot = new Bot({
    clinic,
    agenda,
    sessions,
    pauses: new MemoryHumanPauseStore(),
    humanPauseMinutes: env.HUMAN_PAUSE_MINUTES,
    confirmationMode: env.CONFIRMATION_MODE,
    rateLimiter: new RateLimiter(env.RATE_LIMIT_PER_MINUTE),
    ...(aiProvider
      ? { ai: { provider: aiProvider, ...(aiLocal ? { local: aiLocal } : {}), timeoutMs: env.AI_TIMEOUT_MS, maxCallsPerPhonePerDay: env.AI_MAX_CALLS_PER_PHONE_PER_DAY } }
      : {}),
    ...(transcriber
      ? { audio: { transcriber, maxSeconds: env.AUDIO_MAX_SECONDS, timeoutMs: env.AUDIO_TIMEOUT_MS, maxCallsPerPhonePerDay: env.AI_MAX_CALLS_PER_PHONE_PER_DAY } }
      : {}),
  });

  const missing = missingWhatsAppVars(env);
  if (missing.length > 0) {
    logger.warn('whatsapp_sin_configurar', { faltan: missing.join(', '), efecto: 'el webhook responde 503 y no se envían mensajes' });
  }
  const sender: MessageSender =
    missing.length === 0
      ? new WhatsAppClient({
          accessToken: env.WHATSAPP_ACCESS_TOKEN!,
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
          apiVersion: env.WHATSAPP_API_VERSION,
        })
      : { send: () => Promise.reject(new Error('WhatsApp no configurado')), markRead: () => Promise.resolve() };

  const app = createApp({
    bot,
    sender,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET,
  });

  const server = app.listen(env.PORT, () => {
    logger.info('servidor_iniciado', { puerto: env.PORT, agenda: env.AGENDA_PROVIDER, confirmacion: env.CONFIRMATION_MODE, ia: env.AI_PROVIDER });
  });

  const shutdown = (): void => {
    logger.info('apagando');
    sessions.stopSweeper();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
