// Proveedor Gemini por REST con fetch (sin SDK). API key en el encabezado x-goog-api-key, nunca en la URL.
//
// IMPORTANTE: nunca se probó contra el servicio real. La forma de la petición y de la respuesta
// (endpoint, nombres de campos, esquema de salida) está escrita de memoria y DEBE verificarse contra
// la documentación oficial: https://ai.google.dev/api/generate-content
// Las funciones marcadas "verificar contra documentación oficial" están aisladas para ajustarlas fácil.

import { parseInterpretation } from './guards.js';
import { AI_INTENTS, NO_DISPONIBLE, AiError, type AiInput, type AiProvider, type Interpretation } from './provider.js';
import { buildSystemInstruction, buildUserContent } from './prompt.js';

// verificar contra documentación oficial: URL base y versión de la API
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiOptions {
  apiKey: string;
  /** Obligatorio y sin valor por defecto: los modelos cambian seguido. Ver docs/IA.md. */
  model: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  /** Opcional: generationConfig.thinkingConfig.thinkingBudget (0 desactiva el razonamiento en los modelos que lo permiten). */
  thinkingBudget?: number;
}

// verificar contra documentación oficial: esquema de respuesta (subconjunto de OpenAPI; tipos en mayúscula)
export function geminiResponseSchema(): Record<string, unknown> {
  return {
    type: 'OBJECT',
    properties: {
      intent: { type: 'STRING', enum: [...AI_INTENTS] },
      especialidadId: { type: 'STRING' },
      medicoId: { type: 'STRING' },
      fecha: { type: 'STRING', description: 'YYYY-MM-DD' },
      franja: { type: 'STRING', enum: ['manana', 'tarde'] },
      hora: { type: 'STRING', description: 'HH:mm en 24 horas' },
      noDisponible: { type: 'STRING', enum: [...NO_DISPONIBLE], description: 'Solo si piden algo que no está en los datos del centro' },
      respuestaBreve: { type: 'STRING', description: 'Máximo 300 caracteres' },
    },
    required: ['intent'],
  };
}

/** Cuerpo de `generateContent`. verificar contra documentación oficial: nombres de campos y generationConfig. */
export function buildGeminiBody(input: AiInput, thinkingBudget?: number): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: buildSystemInstruction(input.clinic) }] },
    contents: [{ role: 'user', parts: [{ text: buildUserContent(input) }] }],
    generationConfig: {
      temperature: 0,
      // Holgado: en modelos con "thinking" esos tokens cuentan contra este tope y podrían truncar el JSON.
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: geminiResponseSchema(),
      // verificar contra documentación oficial: no todos los modelos aceptan thinkingBudget (algunos usan thinkingLevel).
      ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
    },
  };
}

/** URL y encabezados. verificar contra documentación oficial: ruta `models/{modelo}:generateContent` y x-goog-api-key. */
export function buildGeminiRequest(options: GeminiOptions, input: AiInput): { url: string; init: RequestInit } {
  const model = options.model.replace(/^models\//, '');
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
    body: JSON.stringify(buildGeminiBody(input, options.thinkingBudget)),
  };
  if (input.signal) init.signal = input.signal;
  return { url: `${options.baseUrl ?? GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, init };
}

interface GeminiPart {
  text?: unknown;
  thought?: unknown;
}
interface GeminiResponse {
  promptFeedback?: { blockReason?: unknown };
  candidates?: Array<{ finishReason?: unknown; content?: { parts?: GeminiPart[] } }>;
}

const BLOCKING_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

/**
 * Extrae la interpretación de la respuesta. verificar contra documentación oficial:
 * `candidates[0].content.parts[].text`, `finishReason` y `promptFeedback.blockReason`.
 */
export function parseGeminiResponse(body: unknown): Interpretation {
  const response = (body ?? {}) as GeminiResponse;
  if (response.promptFeedback?.blockReason) throw new AiError('blocked', 'La IA bloqueó la solicitud', false);

  const candidate = response.candidates?.[0];
  if (!candidate) throw new AiError('invalid_response', 'La respuesta de la IA no trae candidatos', true);
  if (typeof candidate.finishReason === 'string' && BLOCKING_FINISH_REASONS.has(candidate.finishReason)) {
    throw new AiError('blocked', 'La IA bloqueó la respuesta', false);
  }

  const text = (candidate.content?.parts ?? [])
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim();
  if (!text) throw new AiError('invalid_response', 'La respuesta de la IA viene vacía', true);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError('invalid_response', 'La respuesta de la IA no es JSON válido', true);
  }
  const interpretation = parseInterpretation(json);
  if (!interpretation) throw new AiError('invalid_response', 'La respuesta de la IA no cumple el esquema', true);
  return interpretation;
}

export class GeminiProvider implements AiProvider {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: GeminiOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async interpret(input: AiInput): Promise<Interpretation | null> {
    const { url, init } = buildGeminiRequest(this.options, input);
    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError' || (error as Error)?.name === 'TimeoutError';
      throw new AiError(aborted ? 'timeout' : 'network', aborted ? 'Tiempo agotado llamando a la IA' : 'No se pudo conectar con la IA', true);
    }
    // Nunca se incluye el cuerpo del error en el mensaje: podría repetir texto del paciente.
    if (response.status === 429) throw new AiError('quota', 'Cuota o límite de tasa de la IA (HTTP 429)', true);
    if (!response.ok) throw new AiError('http', `Error HTTP ${response.status} de la IA`, response.status >= 500);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AiError('invalid_response', 'La respuesta de la IA no es JSON', true);
    }
    return parseGeminiResponse(body);
  }
}
