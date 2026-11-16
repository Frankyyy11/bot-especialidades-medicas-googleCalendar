// Orquesta un mensaje: límite de tasa -> pausa humana -> sesión -> motor -> guardar.
// Lo usan tanto el webhook de WhatsApp como el simulador de terminal.

import type { AgendaProvider, ConfirmationMode } from './agenda/provider.js';
import type { Clinic } from './config/clinic.js';
import { handleMessage } from './engine/engine.js';
import { newSession, type Incoming, type Outgoing } from './engine/types.js';
import type { HumanPauseStore, SessionStore } from './sessions/store.js';
import { logger } from './util/logger.js';
import type { RateLimiter } from './util/rateLimit.js';

export interface BotDeps {
  clinic: Clinic;
  agenda: AgendaProvider;
  sessions: SessionStore;
  pauses: HumanPauseStore;
  humanPauseMinutes: number;
  confirmationMode?: ConfirmationMode;
  rateLimiter?: RateLimiter;
  now?: () => Date;
}

export class Bot {
  /** Cola por teléfono: dos mensajes seguidos del mismo paciente nunca se procesan a la vez. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BotDeps) {}

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
    const result = await handleMessage(
      {
        clinic,
        agenda,
        now: this.deps.now ?? (() => new Date()),
        ...(this.deps.confirmationMode ? { confirmationMode: this.deps.confirmationMode } : {}),
      },
      session,
      incoming,
    );
    await sessions.set(result.session);
    if (result.handoff) await pauses.pause(phone, this.deps.humanPauseMinutes);

    logger.info('mensaje_procesado', { phone, estado: result.session.state, respuestas: result.replies.length });
    return result.replies;
  }
}
