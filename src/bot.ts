// Orquesta un mensaje: límite de tasa -> pausa humana -> sesión -> motor -> guardar.
// Lo usan tanto el webhook de WhatsApp como el simulador de terminal.

import type { AgendaProvider, ConfirmationMode } from './agenda/provider.js';
import { AiCallBudget } from './ai/budget.js';
import { guardBrief, outgoingText, validateInterpretation } from './ai/guards.js';
import { redactForAi, MAX_HISTORY_TURNS } from './ai/prompt.js';
import { AiError, type AiInput, type AiProvider, type Interpretation } from './ai/provider.js';
import { interpretWithRetry } from './ai/safe.js';
import { audioDurationSeconds, maxBytesForSeconds, normalizeAudioMime, type AudioClip, type Transcriber, type Transcription } from './ai/transcribe.js';
import { findDoctor, findSpecialty, type Clinic } from './config/clinic.js';
import { handleMessage, planAi, type Assist, type EngineResult } from './engine/engine.js';
import { M } from './engine/messages.js';
import { FREE_TEXT_STATES } from './engine/states/assist.js';
import type { EngineContext } from './engine/states/common.js';
import { newBooking, newSession, type Incoming, type Outgoing, type PendingAudio, type Session } from './engine/types.js';
import type { HumanPauseStore, SessionStore } from './sessions/store.js';
import { dayName, todayCR } from './util/dates.js';
import { logger } from './util/logger.js';
import type { RateLimiter } from './util/rateLimit.js';

/** Capa de IA opcional (SPEC-IA.md). Sin esto el bot funciona solo con reglas, como siempre. */
export interface BotAiConfig {
  provider: AiProvider;
  /**
   * Intérprete local por reglas (instantáneo, sin red). Si entiende por sí solo una reserva con sus datos,
   * se usa sin llamar al proveedor remoto; y si el remoto falla o tarda, sirve de respaldo.
   */
  local?: AiProvider;
  /** Tiempo máximo por intento (por defecto 6000 ms). */
  timeoutMs?: number;
  /** Tope diario de llamadas por teléfono (por defecto 40). */
  maxCallsPerPhonePerDay?: number;
}

/** Transcripción de notas de voz (SPEC-AUDIO.md). Sin esto los audios se contestan pidiendo texto, como siempre. */
export interface BotAudioConfig {
  transcriber: Transcriber;
  /** Duración máxima aceptada (por defecto 60 s). */
  maxSeconds?: number;
  /** Tiempo máximo para descargar y transcribir (por defecto 20000 ms). No se reintenta. */
  timeoutMs?: number;
  /** Tope diario por teléfono si no hay capa de IA que lo defina (por defecto 40). Se comparte con la IA. */
  maxCallsPerPhonePerDay?: number;
}

/** De dónde sale el audio (WhatsApp o un archivo del simulador). Se descarga solo si se va a procesar. */
export interface AudioSource {
  load(signal?: AbortSignal): Promise<AudioClip>;
}

export interface AudioHooks {
  /** Envía el acuse inmediato ("Recibí su audio...") antes de descargar y transcribir. */
  ack?: (message: Outgoing) => void | Promise<void>;
}

export interface BotDeps {
  clinic: Clinic;
  agenda: AgendaProvider;
  sessions: SessionStore;
  pauses: HumanPauseStore;
  humanPauseMinutes: number;
  confirmationMode?: ConfirmationMode;
  rateLimiter?: RateLimiter;
  ai?: BotAiConfig;
  audio?: BotAudioConfig;
  now?: () => Date;
}

export class Bot {
  /** Cola por teléfono: dos mensajes seguidos del mismo paciente nunca se procesan a la vez. */
  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly budget: AiCallBudget | undefined;

  constructor(private readonly deps: BotDeps) {
    // Un solo tope diario por teléfono para la IA y para los audios.
    this.budget =
      deps.ai || deps.audio
        ? new AiCallBudget(deps.ai?.maxCallsPerPhonePerDay ?? deps.audio?.maxCallsPerPhonePerDay ?? 40, () => this.now())
        : undefined;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Devuelve las respuestas a enviar (vacío si el bot está pausado o se excedió el límite de tasa). */
  handle(phone: string, incoming: Incoming): Promise<Outgoing[]> {
    return this.enqueue(phone, () => this.process(phone, incoming));
  }

  /** Recepción respondió a mano desde la app (coexistencia): el bot calla en esa conversación. */
  async onHumanReply(phone: string): Promise<void> {
    await this.deps.pauses.pause(phone, this.deps.humanPauseMinutes);
    logger.info('pausa_por_recepcion', { phone, minutes: this.deps.humanPauseMinutes });
  }

  /** true si las notas de voz se transcriben; si no, se contestan pidiendo texto. */
  get audioEnabled(): boolean {
    return Boolean(this.deps.audio);
  }

  /**
   * Nota de voz: acuse -> descarga -> validación -> transcripción -> el texto entra como un mensaje escrito.
   * Usa la misma cola por teléfono que `handle`. El audio y el texto transcrito nunca se guardan ni se registran.
   */
  handleAudio(phone: string, source: AudioSource, hooks: AudioHooks = {}): Promise<Outgoing[]> {
    return this.enqueue(phone, () => this.processAudio(phone, source, hooks));
  }

  private enqueue(phone: string, job: () => Promise<Outgoing[]>): Promise<Outgoing[]> {
    const previous = this.queues.get(phone) ?? Promise.resolve();
    const next = previous.then(job);
    const tail = next.catch(() => undefined);
    this.queues.set(phone, tail);
    void tail.then(() => {
      if (this.queues.get(phone) === tail) this.queues.delete(phone);
    });
    return next;
  }

  private context(): EngineContext {
    return {
      clinic: this.deps.clinic,
      agenda: this.deps.agenda,
      now: () => this.now(),
      aiEnabled: Boolean(this.deps.ai),
      audioEnabled: Boolean(this.deps.audio),
      ...(this.deps.confirmationMode ? { confirmationMode: this.deps.confirmationMode } : {}),
    };
  }

  /** Límite de tasa y pausa humana. false = el bot no debe responder. */
  private async admit(phone: string): Promise<boolean> {
    const { pauses, rateLimiter } = this.deps;
    if (rateLimiter && !rateLimiter.allow(phone)) {
      logger.warn('limite_de_tasa', { phone });
      return false;
    }
    if (await pauses.isPaused(phone)) {
      logger.debug('bot_pausado', { phone });
      return false;
    }
    return true;
  }

  private async process(phone: string, incoming: Incoming): Promise<Outgoing[]> {
    if (!(await this.admit(phone))) return [];
    const session = (await this.deps.sessions.get(phone)) ?? newSession(phone);
    return this.commit(phone, await this.evaluate(session, incoming));
  }

  /** Decide la respuesta sin guardar nada (el motor es puro; la IA solo interpreta). */
  private async evaluate(session: Session, incoming: Incoming, viaAudio = false): Promise<Evaluation> {
    const { clinic } = this.deps;
    const phone = session.phone;
    const ctx = this.context();
    const options = viaAudio ? { viaAudio: true } : {};

    // Orden de seguridad: las urgencias y el límite médico se resuelven por reglas ANTES de cualquier IA
    // (planAi devuelve 'skip' en esos casos). La IA solo entra si las reglas no resolvieron el mensaje.
    const plan = this.deps.ai && incoming.type === 'text' ? planAi(ctx, session, incoming) : 'skip';
    let consulted: Consulted | undefined;
    let result: EngineResult;
    if (plan === 'refine' && incoming.type === 'text') {
      consulted = await this.consult(ctx, session, incoming.text, 'refine');
      result = await handleMessage(ctx, session, incoming, consulted?.assist, options);
    } else {
      result = await handleMessage(ctx, session, incoming, undefined, options);
      if (plan === 'fallback' && result.unresolved && incoming.type === 'text') {
        consulted = await this.consult(ctx, session, incoming.text, 'fallback');
        if (consulted?.assist) result = await handleMessage(ctx, session, incoming, consulted.assist, options);
      }
    }

    let replies = result.replies;
    let briefUsed: string | undefined;
    if (consulted?.brief && result.briefSlot) {
      // Las guardas se aplican al final, con el texto que el código ya va a enviar (sus números son válidos).
      const verdict = guardBrief(consulted.brief, clinic, outgoingText(replies));
      if (verdict.ok && verdict.text) {
        briefUsed = verdict.text;
        replies = [...replies];
        replies.splice(result.briefSlot.insertAt, 0, { type: 'text', body: verdict.text });
      } else {
        logger.info('ia_respuesta_descartada', { phone, motivo: verdict.reason });
      }
    } else if (consulted?.brief) {
      logger.info('ia_respuesta_descartada', { phone, motivo: 'no_aplica' });
    }
    if (consulted) this.recordHistory(result.session, incoming, briefUsed);
    return { result, replies, ...(consulted?.assist ? { interpretation: consulted.assist.interpretation } : {}) };
  }

  private async commit(phone: string, evaluation: Evaluation): Promise<Outgoing[]> {
    const { result, replies } = evaluation;
    await this.deps.sessions.set(result.session);
    if (result.handoff) await this.deps.pauses.pause(phone, this.deps.humanPauseMinutes);
    logger.info('mensaje_procesado', { phone, estado: result.session.state, respuestas: replies.length });
    return replies;
  }

  private async processAudio(phone: string, source: AudioSource, hooks: AudioHooks): Promise<Outgoing[]> {
    const audio = this.deps.audio;
    // Función apagada: comportamiento de siempre (se pide texto).
    if (!audio) return this.process(phone, { type: 'unsupported', kind: 'audio' });
    if (!(await this.admit(phone))) return [];

    const { sessions, clinic } = this.deps;
    const session = (await sessions.get(phone)) ?? newSession(phone);
    const greeting = session.greeted ? [] : [M.greeting(clinic, Boolean(this.deps.ai), true)];
    /** Respuesta que no pasa por el motor: conserva el paso en que estaba el paciente. */
    const reply = async (...messages: Outgoing[]): Promise<Outgoing[]> => {
      const { pendingAudio: _discarded, ...rest } = session;
      await sessions.set({ ...rest, greeted: true });
      return [...greeting, ...messages];
    };

    // Nombre y cédula nunca se toman de un audio (ni se envía a la IA nada de esos pasos).
    if (FREE_TEXT_STATES.has(session.state)) return reply(M.audioTypeInstead());

    if (!this.budget?.tryConsume(phone)) {
      logger.info('audio_tope_diario', { phone });
      return reply(M.audioFailed());
    }

    try {
      await hooks.ack?.(M.audioAck());
    } catch {
      // El acuse es una cortesía: si no se pudo enviar, se sigue con la respuesta.
    }

    const maxSeconds = audio.maxSeconds ?? 60;
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = audio.timeoutMs ?? 20_000;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiError('timeout', `El audio no se procesó en ${timeoutMs} ms`, true));
      }, timeoutMs);
    });

    let transcription: Transcription;
    let seconds: number | undefined;
    try {
      const outcome = await Promise.race([
        (async (): Promise<Transcription | 'largo' | 'formato'> => {
          const clip = await source.load(controller.signal);
          if (!normalizeAudioMime(clip.mimeType) && !clip.mimeType.startsWith('text/plain')) return 'formato';
          seconds = audioDurationSeconds(clip.data, clip.mimeType);
          const tooLong = seconds !== undefined ? seconds > maxSeconds : clip.data.length > maxBytesForSeconds(maxSeconds);
          if (tooLong) return 'largo';
          try {
            return await audio.transcriber.transcribe({ ...clip, signal: controller.signal });
          } catch (error) {
            // Un fallo transitorio (503 "high demand", red) se reintenta UNA vez si queda al menos la mitad del
            // tiempo; un tiempo agotado nunca. El tiempo máximo total sigue siendo `timeoutMs`.
            const transient = error instanceof AiError && error.retryable && error.kind !== 'timeout';
            if (!transient || Date.now() - started > timeoutMs / 2) throw error;
            logger.info('audio_reintento', { phone, tipo: error.kind, ms: Date.now() - started });
            return audio.transcriber.transcribe({ ...clip, signal: controller.signal });
          }
        })(),
        deadline,
      ]);
      const duracion = seconds !== undefined ? Math.round(seconds * 10) / 10 : undefined;
      if (outcome === 'largo') {
        logger.info('audio_descartado', { phone, motivo: 'duracion', audio_s: duracion });
        return reply(M.audioTooLong(maxSeconds));
      }
      if (outcome === 'formato') {
        logger.info('audio_descartado', { phone, motivo: 'formato' });
        return reply(M.audioFailed());
      }
      transcription = outcome;
      // Solo números: duración, latencia y tokens. Nunca el audio ni el texto.
      logger.info('audio_transcrito', {
        phone,
        audio_s: duracion,
        ms: Date.now() - started,
        tokens_entrada: transcription.inputTokens,
        tokens_salida: transcription.outputTokens,
      });
    } catch (error) {
      logger.warn('audio_fallo', { phone, tipo: error instanceof AiError ? error.kind : 'descarga', ms: Date.now() - started });
      return reply(M.audioFailed());
    } finally {
      clearTimeout(timer);
    }

    const text = transcription.text.trim();
    if (!text) {
      logger.info('audio_descartado', { phone, motivo: 'vacio' });
      return reply(M.audioFailed());
    }

    // Desde aquí es un mensaje de texto normal: urgencias y límite médico por reglas primero, sin excepciones.
    const evaluation = await this.evaluate(session, { type: 'text', text }, true);
    const pending = evaluation.result.handoff ? undefined : audioBookingChange(session, evaluation.result.session, evaluation.interpretation);
    if (!pending) return this.commit(phone, evaluation);

    // El audio fijaría datos de una reserva: no se avanza. Se muestra lo entendido (datos de la config,
    // nunca el texto transcrito) y se espera el botón.
    const { failures: _failures, ...kept } = session;
    await sessions.set({
      ...kept,
      greeted: true,
      failures: 0,
      pendingAudio: pending,
      ...(evaluation.result.session.aiHistory ? { aiHistory: evaluation.result.session.aiHistory } : {}),
    });
    logger.info('audio_por_confirmar', { phone, estado: session.state });
    const spec = pending.especialidadId ? findSpecialty(clinic, pending.especialidadId) : undefined;
    const doctor = pending.medicoId && pending.medicoId !== 'any' ? findDoctor(clinic, pending.medicoId)?.doctor : undefined;
    return [...greeting, M.audioUnderstood({ spec, doctor, date: pending.fecha, time: pending.hora, franja: pending.franja })];
  }

  /**
   * Pide la interpretación a la IA. Cualquier fallo (tiempo, HTTP, JSON inválido, cuota, bloqueo) cae en silencio
   * a las reglas: devuelve `undefined` y el paciente nunca ve un error técnico. No se registra contenido.
   */
  private async consult(ctx: EngineContext, session: Session, text: string, mode: Assist['mode']): Promise<Consulted | undefined> {
    const ai = this.deps.ai;
    const phone = session.phone;
    if (!ai || !this.budget) return undefined;

    const today = todayCR(this.now());
    const input: AiInput = {
      text: redactForAi(text),
      history: (session.aiHistory ?? []).slice(-MAX_HISTORY_TURNS),
      clinic: ctx.clinic,
      today,
      weekday: dayName(today),
      state: session.state,
    };
    const started = Date.now();
    const finish = (interpretation: Interpretation, origen: 'ia' | 'local'): Consulted => {
      const { respuestaBreve, ...rest } = interpretation;
      logger.info(origen === 'ia' ? 'ia_usada' : 'ia_local', { phone, modo: mode, intent: rest.intent, ms: Date.now() - started });
      return {
        assist: { interpretation: rest, mode, briefOk: guardBrief(respuestaBreve, ctx.clinic).ok },
        ...(respuestaBreve ? { brief: respuestaBreve } : {}),
      };
    };

    // 1) Intérprete local: si ya entiende una reserva con sus datos, no hace falta esperar a la IA remota.
    let local: Interpretation | undefined;
    if (ai.local) {
      try {
        local = validateInterpretation(await ai.local.interpret(input), { clinic: ctx.clinic, today }) ?? undefined;
      } catch {
        local = undefined;
      }
      if (local && local.intent === 'agendar' && (local.fecha || local.hora || local.franja)) return finish(local, 'local');
    }

    // 2) IA remota (con tope diario). Si falla o tarda, se usa lo que haya entendido el intérprete local.
    const localFallback = (): Consulted | undefined => (local && (local.intent !== 'otro' || local.noDisponible) ? finish(local, 'local') : undefined);
    if (!this.budget.tryConsume(phone)) {
      logger.info('ia_tope_diario', { phone });
      return localFallback();
    }
    let raw: unknown;
    try {
      raw = await interpretWithRetry(ai.provider, input, ai.timeoutMs ?? 6000);
    } catch (error) {
      logger.warn('ia_fallo', { phone, tipo: error instanceof AiError ? error.kind : 'desconocido', ms: Date.now() - started });
      return localFallback();
    }

    const interpretation = validateInterpretation(raw, { clinic: ctx.clinic, today });
    if (!interpretation) {
      logger.info('ia_descartada', { phone, ms: Date.now() - started, motivo: 'sin_interpretacion' });
      return localFallback() ?? {};
    }
    return finish(interpretation, 'ia');
  }

  /** Historial breve de la sesión para la IA: solo texto ya enviado a la IA (sin números largos) y frases guardadas. */
  private recordHistory(session: Session, incoming: Incoming, brief: string | undefined): void {
    if (incoming.type !== 'text') return;
    const turns = [...(session.aiHistory ?? []), { role: 'paciente' as const, text: redactForAi(incoming.text).slice(0, 300) }];
    if (brief) turns.push({ role: 'asistente' as const, text: brief });
    session.aiHistory = turns.slice(-MAX_HISTORY_TURNS);
  }
}

interface Evaluation {
  result: EngineResult;
  replies: Outgoing[];
  /** Interpretación validada de la IA, si se consultó (para conservar el día u hora pedidos en un audio). */
  interpretation?: Interpretation;
}

/**
 * ¿La nota de voz fijaría algún dato de la reserva (especialidad, médico, día u hora)? Si es así devuelve
 * esos datos (solo ids y fechas ya validados) para pedir confirmación antes de avanzar.
 */
export function audioBookingChange(before: Session, after: Session, interpretation?: Interpretation): PendingAudio | undefined {
  if (!after.state.startsWith('AGENDAR_')) return undefined;
  const a = after.booking;
  const b = before.state.startsWith('AGENDAR_') ? before.booking : newBooking();
  const booking = interpretation && (interpretation.intent === 'agendar' || interpretation.intent === 'otro') ? interpretation : undefined;
  const fecha = a.date ?? booking?.fecha;
  const hora = a.time ?? a.horaPref ?? booking?.hora;
  const franja = a.franja ?? booking?.franja;
  const changed =
    (a.especialidadId !== undefined && a.especialidadId !== b.especialidadId) ||
    (a.medicoId !== undefined && a.medicoId !== b.medicoId) ||
    (fecha !== undefined && fecha !== b.date) ||
    (hora !== undefined && hora !== (b.time ?? b.horaPref)) ||
    (franja !== undefined && franja !== b.franja);
  if (!changed) return undefined;
  return {
    ...(a.especialidadId ? { especialidadId: a.especialidadId } : {}),
    ...(a.medicoId ? { medicoId: a.medicoId } : {}),
    ...(fecha ? { fecha } : {}),
    ...(franja ? { franja } : {}),
    ...(hora ? { hora } : {}),
  };
}

interface Consulted {
  assist?: Assist;
  /** Frase cruda de la IA: se usa solo si pasa las guardas contra el mensaje final. */
  brief?: string;
}
