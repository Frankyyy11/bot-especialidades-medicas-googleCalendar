import type { Env } from '../env.js';
import { FakeAiProvider } from './fake.js';
import { GeminiProvider } from './gemini.js';
import type { AiProvider } from './provider.js';
import { FakeTranscriber, GeminiTranscriber, type Transcriber } from './transcribe.js';

/** `undefined` con AI_PROVIDER=none: el bot funciona solo con reglas, como antes. */
export function createAiProvider(env: Pick<Env, 'AI_PROVIDER' | 'GEMINI_API_KEY' | 'GEMINI_MODEL'> & Partial<Pick<Env, 'GEMINI_THINKING_LEVEL'>>): AiProvider | undefined {
  switch (env.AI_PROVIDER) {
    case 'none':
      return undefined;
    case 'fake':
      return new FakeAiProvider();
    case 'gemini': {
      if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL) {
        throw new Error('AI_PROVIDER=gemini requiere GEMINI_API_KEY y GEMINI_MODEL.');
      }
      return new GeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        ...(env.GEMINI_THINKING_LEVEL ? { thinkingLevel: env.GEMINI_THINKING_LEVEL } : {}),
      });
    }
  }
}

/** `undefined` con AUDIO_TRANSCRIPTION=off: los audios se contestan pidiendo texto, como siempre. */
export function createTranscriber(
  env: Pick<Env, 'AUDIO_TRANSCRIPTION' | 'GEMINI_API_KEY' | 'GEMINI_MODEL'> & Partial<Pick<Env, 'GEMINI_THINKING_LEVEL'>>,
): Transcriber | undefined {
  switch (env.AUDIO_TRANSCRIPTION) {
    case 'off':
      return undefined;
    case 'fake':
      return new FakeTranscriber();
    case 'gemini': {
      if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL) {
        throw new Error('AUDIO_TRANSCRIPTION=gemini requiere GEMINI_API_KEY y GEMINI_MODEL.');
      }
      return new GeminiTranscriber({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        ...(env.GEMINI_THINKING_LEVEL ? { thinkingLevel: env.GEMINI_THINKING_LEVEL } : {}),
      });
    }
  }
}

/**
 * Intérprete local por reglas que acompaña a la IA remota: resuelve al instante las frases de reserva
 * claras ("cardiología el miércoles a las 4") y sirve de respaldo si la IA remota falla o tarda.
 */
export function createLocalInterpreter(env: Pick<Env, 'AI_PROVIDER'>): AiProvider | undefined {
  return env.AI_PROVIDER === 'gemini' ? new FakeAiProvider() : undefined;
}
