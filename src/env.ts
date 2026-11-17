import { z } from 'zod';

// Las variables vacías (FOO=) se tratan como ausentes.
const optionalText = z.string().trim().min(1).optional();

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CLINIC_CONFIG_PATH: z.string().default('config/centro.json'),

  AGENDA_PROVIDER: z.enum(['google', 'memory', 'siku']).default('google'),
  CONFIRMATION_MODE: z.enum(['recepcion', 'auto']).default('recepcion'),
  GOOGLE_SERVICE_ACCOUNT_FILE: optionalText,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalText,

  WHATSAPP_VERIFY_TOKEN: optionalText,
  WHATSAPP_APP_SECRET: optionalText,
  WHATSAPP_ACCESS_TOKEN: optionalText,
  WHATSAPP_PHONE_NUMBER_ID: optionalText,
  // Valor por defecto de ejemplo: verificar la versión vigente en la documentación de Meta.
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'Debe tener la forma v23.0').default('v23.0'),

  // Capa de IA opcional (ver docs/IA.md). Con `none` el bot funciona solo con reglas.
  AI_PROVIDER: z.enum(['none', 'gemini', 'fake']).default('none'),
  GEMINI_API_KEY: optionalText,
  // Sin valor por defecto a propósito: los modelos cambian seguido (ver docs/IA.md para listarlos).
  GEMINI_MODEL: optionalText,
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  AI_MAX_CALLS_PER_PHONE_PER_DAY: z.coerce.number().int().min(0).default(40),

  HUMAN_PAUSE_MINUTES: z.coerce.number().positive().default(120),
  SESSION_TTL_MINUTES: z.coerce.number().positive().default(30),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
}).superRefine((env, ctx) => {
  if (env.AI_PROVIDER !== 'gemini') return;
  for (const name of ['GEMINI_API_KEY', 'GEMINI_MODEL'] as const) {
    if (!env[name]) ctx.addIssue({ code: 'custom', path: [name], message: `es obligatoria con AI_PROVIDER=gemini` });
  }
});

export type Env = z.infer<typeof schema>;

/** Nombres de todas las variables que el programa reconoce (para pruebas y documentación). */
export const ENV_KEYS: string[] = Object.keys(schema.shape);

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(general)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Variables de entorno inválidas:\n${detail}\nRevise su archivo .env (vea .env.example).`);
  }
  return result.data;
}

/** Variables necesarias para hablar con WhatsApp. Si falta alguna, el webhook queda deshabilitado. */
export function missingWhatsAppVars(env: Env): string[] {
  const required = [
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
  ] as const;
  return required.filter((name) => !env[name]);
}
