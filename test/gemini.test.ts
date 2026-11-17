// Proveedor Gemini con `fetch` simulado (sin red). OJO: estas pruebas verifican que el código cumple lo que
// ESTE repositorio supone de la API, no la API real. La forma de la petición se comprobó aparte contra el
// servicio real el 2026-11-16 (ver docs/IA.md); aquí nunca se usa la red.
import { describe, expect, it, vi } from 'vitest';
import { FakeAiProvider } from '../src/ai/fake.js';
import { createAiProvider } from '../src/ai/index.js';
import { buildGeminiBody, buildGeminiRequest, GeminiProvider, parseGeminiResponse } from '../src/ai/gemini.js';
import { AiError, type AiInput } from '../src/ai/provider.js';
import { interpretWithRetry } from '../src/ai/safe.js';
import { loadEnv } from '../src/env.js';
import { allText, createHarness, lastList, PHONE } from './helpers.js';

const KEY = 'AIza-clave-de-prueba-123';
const clinic = createHarness().clinic;
const input: AiInput = { text: 'ocupo cita con cardiología el jueves en la tarde', history: [], clinic, today: '2026-11-16', weekday: 'lunes', state: 'MENU' };

const geminiBody = (json: unknown) => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(json) }] } }] });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('petición a Gemini', () => {
  const { url, init } = buildGeminiRequest({ apiKey: KEY, model: 'modelo-de-prueba' }, input);
  const body = JSON.parse(init.body as string);

  it('usa el endpoint generateContent v1beta y la key solo en el encabezado x-goog-api-key', () => {
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/modelo-de-prueba:generateContent');
    expect(url).not.toContain(KEY);
    expect(url).not.toContain('key=');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': KEY, 'content-type': 'application/json' });
    expect(init.body as string).not.toContain(KEY);
  });

  it('acepta el modelo con o sin el prefijo "models/"', () => {
    expect(buildGeminiRequest({ apiKey: KEY, model: 'models/otro' }, input).url).toContain('/models/otro:generateContent');
  });

  it('lleva systemInstruction, el mensaje como contenido y salida JSON con esquema', () => {
    expect(body.systemInstruction.parts[0].text).toContain('DATOS DEL CENTRO');
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toContain(input.text);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    const schema = body.generationConfig.responseSchema;
    expect(schema.required).toEqual(['intent']);
    expect(schema.properties.intent.enum).toContain('agendar');
    expect(Object.keys(schema.properties)).toEqual(['intent', 'especialidadId', 'medicoId', 'fecha', 'franja', 'hora', 'noDisponible', 'respuestaBreve']);
    expect(body.generationConfig.temperature).toBe(0);
  });

  it('thinkingLevel: solo se envía si está configurado, y nunca thinkingBudget', () => {
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    const withLevel = JSON.parse(buildGeminiRequest({ apiKey: KEY, model: 'm', thinkingLevel: 'minimal' }, input).init.body as string);
    expect(withLevel.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(JSON.stringify(withLevel)).not.toContain('thinkingBudget');
  });

  it('el cuerpo no contiene teléfono, nombre ni la key', () => {
    const text = JSON.stringify(buildGeminiBody(input));
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(KEY);
  });
});

describe('respuesta de Gemini', () => {
  it('extrae la interpretación del JSON de la respuesta', () => {
    expect(parseGeminiResponse(geminiBody({ intent: 'agendar', especialidadId: 'cardiologia', franja: 'tarde' }))).toEqual({
      intent: 'agendar',
      especialidadId: 'cardiologia',
      franja: 'tarde',
    });
  });

  it('ignora las partes de razonamiento y une el texto', () => {
    const body = { candidates: [{ content: { parts: [{ thought: true, text: 'pensando...' }, { text: '{"intent":' }, { text: '"saludo"}' }] } }] };
    expect(parseGeminiResponse(body)).toEqual({ intent: 'saludo' });
  });

  it.each([
    ['bloqueo de la solicitud', { promptFeedback: { blockReason: 'SAFETY' } }, 'blocked'],
    ['bloqueo de la respuesta', { candidates: [{ finishReason: 'SAFETY' }] }, 'blocked'],
    ['sin candidatos', {}, 'invalid_response'],
    ['texto vacío', { candidates: [{ content: { parts: [] } }] }, 'invalid_response'],
    ['JSON inválido', { candidates: [{ content: { parts: [{ text: 'no es json' }] } }] }, 'invalid_response'],
    ['fuera del esquema', geminiBody({ intent: 'cobrar' }), 'invalid_response'],
  ])('lanza AiError en %s', (_name, body, kind) => {
    expect(() => parseGeminiResponse(body)).toThrowError(AiError);
    try {
      parseGeminiResponse(body);
    } catch (error) {
      expect((error as AiError).kind).toBe(kind);
    }
  });
});

describe('GeminiProvider con fetch simulado', () => {
  it('llama una vez y devuelve la interpretación', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(geminiBody({ intent: 'horario_ubicacion' })));
    const provider = new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: fetchFn as unknown as typeof fetch });
    expect(await provider.interpret(input)).toEqual({ intent: 'horario_ubicacion' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('errores HTTP: 429 y 5xx son reintentables; 4xx no; los mensajes no incluyen el cuerpo', async () => {
    for (const [status, retryable, kind] of [[429, true, 'quota'], [503, true, 'http'], [400, false, 'http'], [403, false, 'http']] as const) {
      const fetchFn = vi.fn(async () => new Response('texto del paciente: ocupo cita', { status }));
      const provider = new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: fetchFn as unknown as typeof fetch });
      const error = await provider.interpret(input).catch((e: unknown) => e as AiError);
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).retryable, String(status)).toBe(retryable);
      expect((error as AiError).kind).toBe(kind);
      expect((error as AiError).message).not.toContain('ocupo cita');
      expect((error as AiError).message).not.toContain(KEY);
    }
  });

  it('error de red -> AiError reintentable; AbortError -> timeout', async () => {
    const network = new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await expect(network.interpret(input)).rejects.toMatchObject({ kind: 'network', retryable: true });
    const aborted = new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: (async () => { throw Object.assign(new Error('abortado'), { name: 'AbortError' }); }) as unknown as typeof fetch });
    await expect(aborted.interpret(input)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reintento: un 503 y luego respuesta buena = éxito con exactamente dos llamadas', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => (n++ === 0 ? new Response('', { status: 503 }) : jsonResponse(geminiBody({ intent: 'saludo' }))));
    const provider = new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: fetchFn as unknown as typeof fetch });
    expect(await interpretWithRetry(provider, input, 1000)).toEqual({ intent: 'saludo' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('un 503 lento no duplica la espera: el reintento solo usa el tiempo que queda', async () => {
    const slow503 = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return new Response('', { status: 503 });
    });
    const provider = new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: slow503 as unknown as typeof fetch });
    const started = Date.now();
    await expect(interpretWithRetry(provider, input, 150)).rejects.toMatchObject({ kind: 'http' });
    expect(slow503).toHaveBeenCalledTimes(1); // ya no queda tiempo útil para otro intento
    expect(Date.now() - started).toBeLessThan(150 + 100);
  });

  it('nunca más de un reintento', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 500 }));
    const provider = new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(interpretWithRetry(provider, input, 1000)).rejects.toBeInstanceOf(AiError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('Gemini integrado al bot (fetch simulado)', () => {
  function harnessWithFetch(fetchFn: typeof fetch) {
    return createHarness({ ai: new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn }) });
  }

  it('texto libre -> horarios reales, y el cuerpo enviado no contiene datos del paciente', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string, headers: init.headers as Record<string, string> });
      return jsonResponse(geminiBody({ intent: 'agendar', especialidadId: 'cardiologia', fecha: '2026-11-19', franja: 'tarde', respuestaBreve: 'Con gusto, le ayudo con su cita de Cardiología.' }));
    }) as unknown as typeof fetch;
    const h = harnessWithFetch(fetchFn);
    const replies = await h.say('ocupo cita con cardiología el jueves en la tarde');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0]!.body).not.toContain(PHONE);
    expect(allText(replies)).toContain('Con gusto, le ayudo con su cita de Cardiología.');
    expect(lastList(replies).body).toContain('jueves 19 de noviembre, por la tarde');
  });

  it('si Gemini falla (500) el bot responde igual que sin IA', async () => {
    const plain = createHarness();
    await plain.say('hola');
    const expected = await plain.say('necesito ayuda con algo');

    const fetchFn = vi.fn(async () => new Response('', { status: 500 }));
    const h = harnessWithFetch(fetchFn as unknown as typeof fetch);
    await h.say('hola');
    const replies = await h.say('necesito ayuda con algo');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(replies).toEqual(expected);
  });

  // Respuesta real de Gemini cuando el modelo está saturado (vista el 2026-11-16).
  const highDemand = () =>
    jsonResponse({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } }, 503);
  const TECHNICAL = /high demand|UNAVAILABLE|503|error|timeout|inteligencia|IA|Gemini/i;

  it('503 "high demand" con intérprete local: el paciente recibe la respuesta local y no nota el fallo', async () => {
    const fetchFn = vi.fn(async () => highDemand());
    const h = createHarness({ ai: new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: fetchFn as unknown as typeof fetch }), aiLocal: new FakeAiProvider() });
    await h.say('hola');
    await h.pick('menu:agendar');

    const missing = await h.say('Odontologia no tiene?');
    expect(fetchFn).toHaveBeenCalledTimes(2); // intento + un reintento, ambos con 503
    expect(allText(missing)).toContain('no contamos con esa especialidad');
    expect(allText(missing)).not.toMatch(TECHNICAL);
    expect((await h.sessions.get(PHONE))?.failures).toBe(0);

    const payment = await h.say('¿puedo pagar con tarjeta o es solo efectivo?');
    expect(allText(payment)).toContain('Formas de pago');
    expect(allText(payment)).not.toMatch(TECHNICAL);
    expect((await h.sessions.get(PHONE))?.state).toBe('AGENDAR_ESPECIALIDAD'); // sigue en su paso
  });

  it('503 "high demand" y el intérprete local tampoco entiende: "no entendido" amable, sin error técnico', async () => {
    const h = createHarness({ ai: new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: (async () => highDemand()) as unknown as typeof fetch }), aiLocal: new FakeAiProvider() });
    await h.say('hola');
    const replies = await h.say('asdf qwer zxcv');
    expect(allText(replies)).toContain('no estoy seguro de haberle entendido');
    expect(allText(replies)).not.toMatch(TECHNICAL);
  });

  it('un 503 seguido de una respuesta buena se recupera sin que el paciente lo note', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => (n++ === 0 ? highDemand() : jsonResponse(geminiBody({ intent: 'otro', noDisponible: 'especialidad' }))));
    const h = createHarness({ ai: new GeminiProvider({ apiKey: KEY, model: 'm', fetchFn: fetchFn as unknown as typeof fetch }) });
    await h.say('hola');
    const replies = await h.say('y para la vista hay algo');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(allText(replies)).toContain('no contamos con esa especialidad');
  });

  it('JSON inválido o bloqueo de seguridad: caída a reglas, sin errores para el paciente', async () => {
    for (const response of [
      () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'esto no es json' }] } }] }),
      () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    ]) {
      const h = harnessWithFetch((async () => response()) as unknown as typeof fetch);
      await h.say('hola');
      const replies = await h.say('necesito ayuda con algo');
      expect(allText(replies)).toContain('no estoy seguro de haberle entendido');
    }
  });
});

describe('configuración de la IA', () => {
  it('por defecto está apagada', () => {
    const env = loadEnv({});
    expect(env.AI_PROVIDER).toBe('none');
    expect(env.AI_TIMEOUT_MS).toBe(6000);
    expect(env.AI_MAX_CALLS_PER_PHONE_PER_DAY).toBe(40);
    expect(createAiProvider(env)).toBeUndefined();
  });

  it('con gemini, GEMINI_MODEL y GEMINI_API_KEY son obligatorias y no hay modelo por defecto', () => {
    expect(() => loadEnv({ AI_PROVIDER: 'gemini' })).toThrow(/GEMINI_MODEL: es obligatoria/);
    expect(() => loadEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })).toThrow(/GEMINI_MODEL/);
    expect(() => loadEnv({ AI_PROVIDER: 'gemini', GEMINI_MODEL: 'm' })).toThrow(/GEMINI_API_KEY/);
    const env = loadEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm' });
    expect(createAiProvider(env)).toBeInstanceOf(GeminiProvider);
    expect(() => loadEnv({ AI_PROVIDER: 'otra' })).toThrow();
  });

  it('GEMINI_THINKING_LEVEL es opcional, sin valor por defecto, y la variable vieja ya no existe', () => {
    const base = { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm' };
    expect(loadEnv(base).GEMINI_THINKING_LEVEL).toBeUndefined();
    expect(loadEnv({ ...base, GEMINI_THINKING_LEVEL: '' }).GEMINI_THINKING_LEVEL).toBeUndefined();
    expect(loadEnv({ ...base, GEMINI_THINKING_LEVEL: ' Minimal ' }).GEMINI_THINKING_LEVEL).toBe('minimal');
    expect(() => loadEnv({ ...base, GEMINI_THINKING_LEVEL: '0' })).toThrow(/GEMINI_THINKING_LEVEL/);
    expect(loadEnv({ ...base, GEMINI_THINKING_BUDGET: '0' })).not.toHaveProperty('GEMINI_THINKING_BUDGET');

    // El nivel configurado llega tal cual a la petición.
    const sent: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent.push(init.body as string);
      return jsonResponse(geminiBody({ intent: 'saludo' }));
    }) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      return createAiProvider(loadEnv({ ...base, GEMINI_THINKING_LEVEL: 'low' }))!
        .interpret(input)
        .then(() => expect(JSON.parse(sent[0]!).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' }));
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fake no necesita credenciales', () => {
    expect(createAiProvider(loadEnv({ AI_PROVIDER: 'fake' }))).toBeDefined();
  });
});
