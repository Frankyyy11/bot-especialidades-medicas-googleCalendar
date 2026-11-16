import type { Session } from '../engine/types.js';

/** Interfaz de almacenamiento de sesiones: hoy en memoria, mañana p. ej. Redis. */
export interface SessionStore {
  get(phone: string): Promise<Session | undefined>;
  set(session: Session): Promise<void>;
  delete(phone: string): Promise<void>;
}

/** Pausa del bot por conversación (recepción atendiendo a mano). */
export interface HumanPauseStore {
  pause(phone: string, minutes: number): Promise<void>;
  isPaused(phone: string): Promise<boolean>;
  resume(phone: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { session: Session; expiresAt: number }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(phone: string): Promise<Session | undefined> {
    const entry = this.sessions.get(phone);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.sessions.delete(phone);
      return undefined;
    }
    return structuredClone(entry.session);
  }

  async set(session: Session): Promise<void> {
    this.sessions.set(session.phone, { session: structuredClone(session), expiresAt: this.now() + this.ttlMs });
  }

  async delete(phone: string): Promise<void> {
    this.sessions.delete(phone);
  }

  /** Limpieza periódica de sesiones vencidas (no mantiene vivo el proceso). */
  startSweeper(everyMs = 5 * 60_000): void {
    this.timer ??= setInterval(() => {
      const t = this.now();
      for (const [phone, entry] of this.sessions) if (entry.expiresAt <= t) this.sessions.delete(phone);
    }, everyMs);
    this.timer.unref();
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export class MemoryHumanPauseStore implements HumanPauseStore {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async pause(phone: string, minutes: number): Promise<void> {
    this.until.set(phone, this.now() + minutes * 60_000);
  }

  async isPaused(phone: string): Promise<boolean> {
    const expiresAt = this.until.get(phone);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.until.delete(phone);
      return false;
    }
    return true;
  }

  async resume(phone: string): Promise<void> {
    this.until.delete(phone);
  }
}
