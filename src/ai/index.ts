import type { Env } from '../env.js';
import { FakeAiProvider } from './fake.js';
import { GeminiProvider } from './gemini.js';
import type { AiProvider } from './provider.js';

/** `undefined` con AI_PROVIDER=none: el bot funciona solo con reglas, como antes. */
export function createAiProvider(env: Pick<Env, 'AI_PROVIDER' | 'GEMINI_API_KEY' | 'GEMINI_MODEL'>): AiProvider | undefined {
  switch (env.AI_PROVIDER) {
    case 'none':
      return undefined;
    case 'fake':
      return new FakeAiProvider();
    case 'gemini': {
      if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL) {
        throw new Error('AI_PROVIDER=gemini requiere GEMINI_API_KEY y GEMINI_MODEL.');
      }
      return new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
    }
  }
}
