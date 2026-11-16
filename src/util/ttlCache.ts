/** Conjunto de claves con expiración (deduplicación de mensajes, etc.). */
export class TtlSet {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Devuelve true si la clave ya estaba (y vigente); si no, la registra y devuelve false. */
  seen(key: string): boolean {
    const t = this.now();
    this.sweep(t);
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > t) return true;
    this.entries.set(key, t + this.ttlMs);
    return false;
  }

  private sweep(t: number): void {
    if (this.entries.size < 1000) return;
    for (const [key, expiresAt] of this.entries) if (expiresAt <= t) this.entries.delete(key);
  }
}
