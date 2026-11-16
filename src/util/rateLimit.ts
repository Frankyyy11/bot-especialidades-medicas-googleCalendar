/** Límite de tasa de ventana deslizante por clave (teléfono). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** true si el mensaje se permite; false si excede el límite. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => h > t - this.windowMs);
    if (recent.length >= this.maxPerWindow) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(t);
    return true;
  }

  private prune(t: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((h) => h <= t - this.windowMs)) this.hits.delete(key);
    }
  }
}
