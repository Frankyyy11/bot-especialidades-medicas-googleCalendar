// Llamada tolerante a fallos: UN reintento como máximo y un tiempo máximo TOTAL (los dos intentos juntos).
// Cualquier fallo final se propaga como AiError; quien llama cae silenciosamente a las reglas.

import { AiError, type AiInput, type AiProvider, type Interpretation } from './provider.js';

function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  // Error desconocido: se reporta sin su mensaje (podría contener texto del paciente).
  return new AiError('network', 'Error inesperado al llamar a la IA', true);
}

async function attempt(provider: AiProvider, input: AiInput, timeoutMs: number): Promise<Interpretation | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiError('timeout', `La IA no respondió en ${timeoutMs} ms`, true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.interpret({ ...input, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Con menos tiempo que este no vale la pena reintentar: el paciente ya esperó casi todo el máximo. */
const MIN_RETRY_MS = 300;

export async function interpretWithRetry(provider: AiProvider, input: AiInput, timeoutMs: number): Promise<Interpretation | null> {
  const started = Date.now();
  try {
    return await attempt(provider, input, timeoutMs);
  } catch (first) {
    const error = toAiError(first);
    // Un tiempo agotado no se reintenta: duplicaría la espera del paciente. El resto (red, 5xx, JSON) sí, una vez.
    if (!error.retryable || error.kind === 'timeout') throw error;
    // El reintento solo dispone del tiempo que queda: un 503 lento ("high demand") no puede duplicar la espera.
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining < MIN_RETRY_MS) throw error;
    try {
      return await attempt(provider, input, remaining);
    } catch (second) {
      throw toAiError(second);
    }
  }
}
