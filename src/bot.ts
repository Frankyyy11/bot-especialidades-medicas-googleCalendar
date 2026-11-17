// Orquesta un mensaje: límite de tasa -> pausa humana -> sesión -> motor -> guardar.
// Lo usan tanto el webhook de WhatsApp como el simulador de terminal.

import type { AgendaProvider, ConfirmationMode } from './agenda/provider.js';
import { AiCallBudget } from './ai/budget.js';
import { guardBrief, outgoingText, validateInterpretation } from './ai/guards.js';
import { redactForAi, MAX_HISTORY_TURNS } from './ai/prompt.js';
import { AiError, type AiInput, type AiProvider, type Interpretation } from './ai/provider.js';
import { interpretWithRetry } from './ai/safe.js';
import type { Clinic } from './config/clinic.js';
import { handleMessage, planAi, type Assist, type EngineResult } from './engine/engine.js';
import type { EngineContext } from './engine/states/common.js';
import { newSession, type Incoming, type Outgoing, type Session } from './engine/types.js';
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

export interface BotDeps {
  clinic: Clinic;
  agenda: AgendaProvider;
  sessions: SessionStore;
  pauses: HumanPauseStore;
  humanPauseMinutes: number;
  confirmationMode?: ConfirmationMode;
  rateLimiter?: RateLimiter;
  ai?: BotAiConfig;
  now?: () => Date;
}

export class Bot {
  /** Cola por teléfono: dos mensajes seguidos del mismo paciente nunca se procesan a la vez. */
  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly budget: AiCallBudget | undefined;

  constructor(private readonly deps: BotDeps) {
    this.budget = deps.ai ? new AiCallBudget(deps.ai.maxCallsPerPhonePerDay ?? 40, () => this.now()) : undefined;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Devuelve las respuestas a enviar (vacío si el bot está pausado o se excedió el límite de tasa). */
  handle(phone: string, incoming: Incoming): Promise<Outgoing[]> {
    const previous = this.queues.get(phone) ?? Promise.resolve();
    const next = previous.then(() => this.process(phone, incoming));
    const tail = next.catch(() => undefined);
    this.queues.set(phone, tail);
    void tail.then(() => {
      if (this.queues.get(phone) === tail) this.queues.delete(phone);
    });
    return next;
  }

  /** Recepción respondió a mano desde la app (coexistencia): el bot calla en esa conversación. */
  async onHumanReply(phone: string): Promise<void> {
    await this.deps.pauses.pause(phone, this.deps.humanPauseMinutes);
    logger.info('pausa_por_recepcion', { phone, minutes: this.deps.humanPauseMinutes });
  }

  private async process(phone: string, incoming: Incoming): Promise<Outgoing[]> {
    const { sessions, pauses, rateLimiter, clinic, agenda } = this.deps;

    if (rateLimiter && !rateLimiter.allow(phone)) {
      logger.warn('limite_de_tasa', { phone });
      return [];
    }
    if (await pauses.isPaused(phone)) {
      logger.debug('bot_pausado', { phone });
      return [];
    }

    const session = (await sessions.get(phone)) ?? newSession(phone);
    const ctx: EngineContext = {
      clinic,
      agenda,
      now: () => this.now(),
      aiEnabled: Boolean(this.deps.ai),
      ...(this.deps.confirmationMode ? { confirmationMode: this.deps.confirmationMode } : {}),
    };

    // Orden de seguridad: las urgencias y el límite médico se resuelven por reglas ANTES de cualquier IA
    // (planAi devuelve 'skip' en esos casos). La IA solo entra si las reglas no resolvieron el mensaje.
    const plan = this.deps.ai && incoming.type === 'text' ? planAi(ctx, session, incoming) : 'skip';
    let consulted: Consulted | undefined;
    let result: EngineResult;
    if (plan === 'refine' && incoming.type === 'text') {
      consulted = await this.consult(ctx, session, incoming.text, 'refine');
      result = await handleMessage(ctx, session, incoming, consulted?.assist);
    } else {
      result = await handleMessage(ctx, session, incoming);
      if (plan === 'fallback' && result.unresolved && incoming.type === 'text') {
        consulted = await this.consult(ctx, session, incoming.text, 'fallback');
        if (consulted?.assist) result = await handleMessage(ctx, session, incoming, consulted.assist);
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
    await sessions.set(result.session);
    if (result.handoff) await pauses.pause(phone, this.deps.humanPauseMinutes);

    logger.info('mensaje_procesado', { phone, estado: result.session.state, respuestas: replies.length });
    return replies;
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
    const localFallback = (): Consulted | undefined => (local && local.intent !== 'otro' ? finish(local, 'local') : undefined);
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

interface Consulted {
  assist?: Assist;
  /** Frase cruda de la IA: se usa solo si pasa las guardas contra el mensaje final. */
  brief?: string;
}
