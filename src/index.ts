import 'dotenv/config';
import { createAgendaProvider } from './agenda/index.js';
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
    logger.info('servidor_iniciado', { puerto: env.PORT, agenda: env.AGENDA_PROVIDER, confirmacion: env.CONFIRMATION_MODE });
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
