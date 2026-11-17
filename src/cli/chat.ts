// Simulador de terminal: conversa con el motor usando la agenda en memoria.
// No necesita WhatsApp ni Google. Uso: npm run chat
// También acepta un guion por entrada estándar:  printf 'hola\n1\n' | npm run chat
// IA: si AI_PROVIDER no está definida (ni en el entorno ni en .env) usa el proveedor simulado (fake). Con AI_PROVIDER=gemini y la key en .env usa Gemini real;
// con AI_PROVIDER=none funciona solo con reglas. CHAT_NOW=2026-11-16T10:00:00-06:00 fija el reloj (guiones reproducibles).

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { MemoryAgendaProvider } from '../agenda/memory.js';
import { createAiProvider, createLocalInterpreter } from '../ai/index.js';
import { Bot } from '../bot.js';
import { loadClinic } from '../config/clinic.js';
import { loadEnv } from '../env.js';
import type { Outgoing } from '../engine/types.js';
import { MemoryHumanPauseStore, MemorySessionStore } from '../sessions/store.js';
import { setLogSink } from '../util/logger.js';
import { fitOutgoing } from '../whatsapp/limits.js';

// El simulador no mezcla los logs JSON con la conversación, aunque el .env diga LOG_LEVEL=info.
// Solo muestra una línea corta con lo que hizo la IA real (útil para saber si Gemini respondió).
// CHAT_LOGS=1 vuelve a mostrar los logs JSON completos.
const showJsonLogs = process.env.CHAT_LOGS === '1';
const dim = (line: string): string => (process.stdout.isTTY ? `\x1b[2m${line}\x1b[0m` : line);
const AI_STATUS: Record<string, (f: Record<string, unknown>) => string> = {
  ia_usada: (f) => `IA: respondió (${String(f.intent)}, ${String(f.ms)} ms)`,
  ia_local: (f) => `Entendido por reglas locales, sin esperar a la IA (${String(f.intent)}, ${String(f.ms)} ms)`,
  ia_fallo: (f) => `IA: falló (${String(f.tipo)}, ${String(f.ms)} ms); se sigue con reglas`,
  ia_descartada: (f) => `IA: sin interpretación útil (${String(f.ms)} ms)`,
  ia_respuesta_descartada: (f) => `IA: frase descartada por las guardas (${String(f.motivo)})`,
  ia_tope_diario: () => 'IA: tope diario alcanzado; se respondió solo con reglas',
};
let showAiStatus = false;
if (!showJsonLogs) {
  setLogSink((_level, event, fields) => {
    const describe = AI_STATUS[event];
    if (showAiStatus && describe) console.log(dim(`     · ${describe(fields)}`));
  });
}

const PHONE = '50600000000'; // número ficticio
const clinic = loadClinic(process.env.CLINIC_CONFIG_PATH ?? 'config/centro.json');
const confirmationMode = process.env.CONFIRMATION_MODE === 'auto' ? 'auto' : 'recepcion';
const humanPauseMinutes = Number(process.env.HUMAN_PAUSE_MINUTES ?? 120);

// El simulador usa IA simulada por defecto; solo se toman de aquí las variables de la capa de IA.
const aiEnv = loadEnv({ ...process.env, AI_PROVIDER: process.env.AI_PROVIDER ?? 'fake' });
const aiProvider = createAiProvider(aiEnv);
const aiLocal = createLocalInterpreter(aiEnv);
// Con la IA simulada la línea de estado no aporta; con Gemini real sí (CHAT_IA=1 la fuerza).
showAiStatus = aiEnv.AI_PROVIDER === 'gemini' || process.env.CHAT_IA === '1';
const fixedNow = process.env.CHAT_NOW ? new Date(process.env.CHAT_NOW) : undefined;
if (fixedNow && Number.isNaN(fixedNow.getTime())) throw new Error('CHAT_NOW no es una fecha válida (use p. ej. 2026-11-16T10:00:00-06:00)');
const now = fixedNow ? () => fixedNow : () => new Date();

const bot = new Bot({
  clinic,
  now,
  ...(aiProvider
    ? { ai: { provider: aiProvider, ...(aiLocal ? { local: aiLocal } : {}), timeoutMs: aiEnv.AI_TIMEOUT_MS, maxCallsPerPhonePerDay: aiEnv.AI_MAX_CALLS_PER_PHONE_PER_DAY } }
    : {}),
  agenda: new MemoryAgendaProvider({ clinic, confirmationMode, now }),
  sessions: new MemorySessionStore(Number(process.env.SESSION_TTL_MINUTES ?? 30) * 60_000),
  pauses: new MemoryHumanPauseStore(),
  humanPauseMinutes,
  confirmationMode,
});

/** Opciones numeradas de lo último que mostró el bot: escribir "2" equivale a tocar la opción 2. */
let options: Array<{ id: string; title: string }> = [];

function render(raw: Outgoing[]): void {
  options = [];
  for (const original of raw) {
    const message = fitOutgoing(original); // el simulador respeta los mismos límites que WhatsApp
    console.log(`\nBOT> ${message.body.replace(/\n/g, '\n     ')}`);
    if (message.type === 'buttons') {
      for (const b of message.buttons) options.push({ id: b.id, title: b.title });
    } else if (message.type === 'list') {
      console.log(`     [${message.buttonLabel}]`);
      for (const r of message.rows) options.push({ id: r.id, title: r.title + (r.description ? ` - ${r.description}` : '') });
      // Las filas se numeran juntas; los botones de un mensaje anterior ya no aplican.
    }
    if (message.type !== 'text') {
      const start = options.length - (message.type === 'buttons' ? message.buttons.length : message.rows.length);
      options.slice(start).forEach((o, i) => console.log(`       ${start + i + 1}) ${o.title}`));
    }
  }
}

async function main(): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY);
  console.log(`Simulador de ${clinic.nombre} (agenda en memoria, IA: ${aiEnv.AI_PROVIDER}). Escriba un número para elegir una opción, o texto libre.`);
  console.log('Comandos: /salir para terminar.');
  if (aiEnv.AI_PROVIDER === 'none') {
    console.log('AVISO: la IA está apagada (AI_PROVIDER=none, probablemente en su .env): el bot responde solo con reglas.');
    console.log('       Para probar la IA simulada:  PowerShell: $env:AI_PROVIDER="fake"; npm run chat   |   bash: AI_PROVIDER=fake npm run chat');
  }
  if (interactive) process.stdout.write('\nUSTED> ');

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const input = line.trim();
    if (input === '/salir') break;
    if (input) {
      if (!interactive) console.log(`\nUSTED> ${input}`);
      const option = /^\d+$/.test(input) ? options[Number(input) - 1] : undefined;
      const incoming = option ? ({ type: 'choice', id: option.id, title: option.title } as const) : ({ type: 'text', text: input } as const);
      const replies = await bot.handle(PHONE, incoming);
      if (replies.length === 0) console.log('\n(el bot está en pausa: recepción atiende esta conversación)');
      else render(replies);
    }
    if (interactive) process.stdout.write('\nUSTED> ');
  }
  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
