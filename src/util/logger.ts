// Logger mínimo en JSON. Regla de privacidad: nunca se registran nombres, cédulas
// ni el cuerpo de los mensajes; los teléfonos se enmascaran (solo últimos 4 dígitos).

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const PHONE_KEYS = new Set(['phone', 'from', 'to', 'telefono']);

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `****${digits.slice(-4)}`;
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (PHONE_KEYS.has(key) && typeof value === 'string') out[key] = maskPhone(value);
    else if (value instanceof Error) out[key] = value.message;
    else out[key] = value;
  }
  return out;
}

function currentLevel(): Level {
  const raw = process.env.LOG_LEVEL;
  return raw && raw in ORDER ? (raw as Level) : 'info';
}

export type LogSink = (level: Level, event: string, fields: Record<string, unknown>) => void;
let sink: LogSink | undefined;

/** Redirige los logs (ya sin datos personales) a otra salida; lo usa el simulador para no mezclar JSON con la conversación. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

function write(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (sink) {
    sink(level, event, sanitize(fields));
    return;
  }
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...sanitize(fields) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
