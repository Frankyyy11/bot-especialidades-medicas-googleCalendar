// Llamada tolerante a fallos: tiempo máximo por intento y UN reintento como máximo.
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

export async function interpretWithRetry(provider: AiProvider, input: AiInput, timeoutMs: number): Promise<Interpretation | null> {
  try {
    return await attempt(provider, input, timeoutMs);
  } catch (first) {
    const error = toAiError(first);
    if (!error.retryable) throw error;
    try {
      return await attempt(provider, input, timeoutMs);
    } catch (second) {
      throw toAiError(second);
    }
  }
}
