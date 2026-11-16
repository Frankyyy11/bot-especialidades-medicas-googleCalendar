import type { Doctor } from '../config/clinic.js';
import {
  addDays,
  dayKey,
  fromCostaRica,
  isoCR,
  minutesOf,
  timeOf,
  todayCR,
} from '../util/dates.js';
import type { Slot } from './provider.js';

export interface BusyInterval {
  start: number; // ms desde epoch
  end: number;
}

export interface SlotRules {
  anticipacionMinHoras: number;
  diasMaxAdelanto: number;
  feriados: readonly string[];
}

export interface ComputeSlotsInput {
  doctorId: string;
  date: string; // YYYY-MM-DD
  /** Rangos de atención del día, p. ej. ["08:00-12:00", "13:00-16:00"]. */
  ranges: readonly string[];
  duracionMin: number;
  busy: readonly BusyInterval[];
  now: Date;
  rules: SlotRules;
}

/**
 * Espacios libres de un médico en una fecha. Función pura:
 * horario partido en bloques de `duracionMin`, menos ocupados, anticipación mínima,
 * límite de días hacia adelante y feriados.
 */
export function computeSlots(input: ComputeSlotsInput): Slot[] {
  const { doctorId, date, ranges, duracionMin, busy, now, rules } = input;

  if (rules.feriados.includes(date)) return [];
  const today = todayCR(now);
  if (date < today || date > addDays(today, rules.diasMaxAdelanto)) return [];

  const earliest = now.getTime() + rules.anticipacionMinHoras * 3_600_000;
  const slots: Slot[] = [];

  for (const range of ranges) {
    const startMin = minutesOf(range.slice(0, 5));
    const endMin = minutesOf(range.slice(6));
    for (let m = startMin; m + duracionMin <= endMin; m += duracionMin) {
      const time = timeOf(m);
      const start = fromCostaRica(date, time).getTime();
      const end = start + duracionMin * 60_000;
      if (start < earliest) continue;
      if (busy.some((b) => start < b.end && end > b.start)) continue;
      slots.push({
        doctorId,
        date,
        time,
        start: isoCR(date, time),
        end: isoCR(date, timeOf(m + duracionMin)),
      });
    }
  }
  return slots;
}

/** Rangos de atención configurados para ese día de la semana. */
export function rangesFor(doctor: Doctor, date: string): string[] {
  return doctor.horario[dayKey(date)] ?? [];
}

/** Prefiltro barato (sin red): ¿el médico atiende ese día y no es feriado? */
export function doctorWorksOn(doctor: Doctor, date: string, feriados: readonly string[]): boolean {
  return !feriados.includes(date) && rangesFor(doctor, date).length > 0;
}

/** Ventana [inicio, fin) del día completo en Costa Rica, en ISO. */
export function dayWindow(date: string): { timeMin: string; timeMax: string } {
  return { timeMin: isoCR(date, '00:00'), timeMax: isoCR(addDays(date, 1), '00:00') };
}
