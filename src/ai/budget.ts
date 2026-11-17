import { todayCR } from '../util/dates.js';

/** Tope diario de llamadas a la IA por teléfono (controla costo y abuso). En memoria, como las sesiones. */
export class AiCallBudget {
  private readonly counts = new Map<string, { day: string; count: number }>();

  constructor(
    private readonly maxPerDay: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** true si todavía hay cupo (y lo consume); false si ya llegó al tope del día. */
  tryConsume(phone: string): boolean {
    const day = todayCR(this.now());
    const entry = this.counts.get(phone);
    if (!entry || entry.day !== day) {
      if (this.counts.size > 5000) this.prune(day);
      this.counts.set(phone, { day, count: 1 });
      return this.maxPerDay >= 1;
    }
    if (entry.count >= this.maxPerDay) return false;
    entry.count += 1;
    return true;
  }

  private prune(day: string): void {
    for (const [phone, entry] of this.counts) if (entry.day !== day) this.counts.delete(phone);
  }
}
