// Utilidades de fecha y hora. Costa Rica es UTC-6 todo el año (sin horario de verano),
// por eso se usa un desfase fijo en lugar de depender de datos de zona horaria del sistema.

export const TIME_ZONE = 'America/Costa_Rica';
const OFFSET_HOURS = -6;
const OFFSET_MS = OFFSET_HOURS * 3_600_000;
export const OFFSET_ISO = '-06:00';

export const DAY_KEYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre',
];
const MONTH_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];

const pad = (n: number): string => String(n).padStart(2, '0');

/** Fecha y hora "de pared" en Costa Rica para un instante dado. */
export function toCostaRica(instant: Date): { date: string; time: string; minutes: number } {
  const shifted = new Date(instant.getTime() + OFFSET_MS);
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  return { date, time, minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

export function todayCR(now: Date): string {
  return toCostaRica(now).date;
}

/** Instante correspondiente a una fecha YYYY-MM-DD y hora HH:MM en Costa Rica. */
export function fromCostaRica(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${OFFSET_ISO}`);
}

/** Cadena ISO con desfase -06:00 (formato que aceptan Google Calendar y la config). */
export function isoCR(date: string, time: string): string {
  return `${date}T${time}:00${OFFSET_ISO}`;
}

export function instantToIsoCR(instant: Date): string {
  const { date, time } = toCostaRica(instant);
  return isoCR(date, time);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const result = new Date(Date.UTC(y, m - 1, d + days));
  return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`;
}

export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dayKey(date: string): DayKey {
  return DAY_KEYS[dayOfWeek(date)] as DayKey;
}

export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function timeOf(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** "9:00 a. m." / "2:30 p. m." */
export function formatTime12(time: string): string {
  const total = minutesOf(time);
  const h24 = Math.floor(total / 60);
  const mm = pad(total % 60);
  const suffix = h24 < 12 ? 'a. m.' : 'p. m.';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${suffix}`;
}

function parts(date: string): { y: number; m: number; d: number; dow: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d, dow: dayOfWeek(date) };
}

/** "viernes 20 de noviembre" */
export function formatDateLong(date: string): string {
  const p = parts(date);
  return `${DAY_NAMES[p.dow]} ${p.d} de ${MONTH_NAMES[p.m - 1]}`;
}

/** "Vie 20 de nov" (cabe en los 24 caracteres de una fila de lista) */
export function formatDateShort(date: string): string {
  const p = parts(date);
  return `${DAY_SHORT[p.dow]} ${p.d} de ${MONTH_SHORT[p.m - 1]}`;
}

/** "20 nov" */
export function formatDayMonth(date: string): string {
  const p = parts(date);
  return `${p.d} ${MONTH_SHORT[p.m - 1]}`;
}

export function dayName(date: string): string {
  return DAY_NAMES[dayOfWeek(date)] as string;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
