// Detección de intención por palabras clave. Todo opera sobre texto normalizado
// (minúsculas, sin tildes ni signos), así "Menú", "MENU" y "menú!" son equivalentes.

import type { Especialidad } from './intentTypes.js';

/** Minúsculas, sin tildes, signos convertidos en espacios y espacios colapsados. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿El texto normalizado contiene la palabra/frase completa? */
function hasPhrase(norm: string, phrase: string): boolean {
  return new RegExp(`(?:^| )${escapeRegex(phrase)}(?: |$)`).test(norm);
}

const anyPhrase = (norm: string, phrases: readonly string[]): boolean => phrases.some((p) => hasPhrase(norm, p));

// --- Urgencias -------------------------------------------------------------

/** Patrones sobre texto normalizado. Revisar con el centro: ante la duda, es mejor que sobren. */
const URGENCY_PATTERNS: RegExp[] = [
  /\bemergencia/,
  /\burgencia/,
  /dolor (de|en el|del) pecho/,
  /duele (el )?pecho/,
  /no (puedo|logro|consigo) respirar/,
  /(me )?falta (el )?(aire|respiracion)/,
  /\bme ahogo\b/,
  /\bsangrad/,
  /\bsangrand/,
  /\bhemorrag/,
  /\bdesmay/,
  /\binfarto/,
  /\bsuicid/,
  /quitarme la vida|quiero morir|ya no quiero vivir/,
  /\bconvulsion/,
  /\bsobredosis\b/,
  /\benvenen/,
  /\binconsciente\b/,
  /perdi el conocimiento/,
  /ataque (cardiaco|al corazon)/,
  /\bderrame\b/,
];

/** Convierte una palabra de la config en regex ("sangrad*" admite cualquier terminación). */
function extraUrgencyRegex(word: string): RegExp | undefined {
  const norm = normalize(word.replace(/\*$/, ''));
  if (!norm) return undefined;
  return new RegExp(`(?:^| )${escapeRegex(norm)}${word.trim().endsWith('*') ? '' : '(?: |$)'}`);
}

export function isUrgent(text: string, extraWords: readonly string[] = []): boolean {
  const norm = normalize(text);
  if (URGENCY_PATTERNS.some((re) => re.test(norm))) return true;
  return extraWords.some((w) => extraUrgencyRegex(w)?.test(norm) ?? false);
}

// --- Límite médico ---------------------------------------------------------

const MEDICAL_PATTERNS: RegExp[] = [
  /\bque (me )?(tomo|puedo tomar|debo tomar|me recomienda|me recomiendan|medicina|medicamento|pastilla|remedio)/,
  /\bque (tengo(?! que)|puede ser|sera)\b/,
  /\bes (grave|serio|normal|peligroso)\b/,
  /\bsera (grave|serio|normal|peligroso)\b/,
  /\b(diagnostico|diagnosticar|sintoma|sintomas|dosis|receta|recetar|medicamento|medicamentos|pastilla|pastillas|antibiotico|analgesico)\b/,
  /\bme duele/,
  /\btengo (dolor|fiebre|tos|mareo|mareos|nauseas|vomito|gripe|diarrea|alergia|ardor|picazon)/,
  /\b(puedo|debo) tomar\b/,
  /\bque hago (si|con|para)\b/,
];

export function isMedicalQuestion(text: string): boolean {
  const norm = normalize(text);
  return MEDICAL_PATTERNS.some((re) => re.test(norm));
}

// --- Navegación global -----------------------------------------------------

const GREETING_TOKENS = new Set([
  'hola', 'holi', 'buenas', 'buenos', 'buen', 'dias', 'dia', 'tardes', 'tarde', 'noches', 'noche',
  'menu', 'principal', 'inicio', 'volver', 'al', 'el', 'saludos', 'ayuda', 'que', 'tal', 'empezar', 'comenzar', 'start',
]);

/** "hola", "buenas tardes", "menú", "volver al menú"... (solo si no hay nada más en el mensaje). */
export function isMenuWord(text: string): boolean {
  const norm = normalize(text);
  if (!norm) return false;
  const tokens = norm.split(' ');
  return tokens.every((t) => GREETING_TOKENS.has(t)) && tokens.some((t) => t !== 'el' && t !== 'al');
}

const HUMAN_WORDS = [
  'recepcion', 'recepcionista', 'asesor', 'asesora', 'humano', 'persona', 'agente', 'secretaria',
  'operador', 'operadora', 'hablar con alguien', 'hablar con una persona',
];

export function wantsHuman(text: string): boolean {
  return anyPhrase(normalize(text), HUMAN_WORDS);
}

/** "salir" o "cancelar" (solos) abandonan el flujo actual. */
export function isExit(text: string): boolean {
  return ['salir', 'cancelar', 'cancelar todo', 'abandonar', 'cancel'].includes(normalize(text));
}

export function isYes(text: string): boolean {
  return ['si', 'sii', 'claro', 'confirmo', 'confirmar', 'ok', 'okey', 'dale', 'correcto', 'de acuerdo'].includes(normalize(text));
}

export function isNo(text: string): boolean {
  return ['no', 'nop', 'negativo'].includes(normalize(text));
}

// --- Intenciones del menú --------------------------------------------------

export type MenuIntent = 'agendar' | 'servicios' | 'horario' | 'citas';

const CITAS_WORDS = [
  'mis citas', 'mi cita', 'cancelar cita', 'cancelar mi cita', 'cancelar la cita', 'cancelo', 'cancelar',
  'reprogramar', 'cambiar mi cita', 'cambiar cita', 'consultar mi cita', 'ver mi cita', 'ver mis citas',
  'anular', 'anular cita',
];
const AGENDAR_WORDS = [
  'cita', 'citas', 'agendar', 'agenda', 'reservar', 'reserva', 'sacar cita', 'consulta', 'turno', 'apartar',
  'agendo', 'agendame', 'espacio',
];
const SERVICIOS_WORDS = [
  'precio', 'precios', 'cuanto cuesta', 'cuanto cobran', 'cuanto vale', 'costo', 'costos', 'tarifa', 'tarifas',
  'especialidades', 'especialidad', 'servicios', 'servicio', 'que ofrecen', 'que atienden', 'medicos', 'doctores',
];
const HORARIO_WORDS = [
  'horario', 'horarios', 'direccion', 'ubicacion', 'donde estan', 'donde queda', 'donde se ubican', 'como llegar',
  'telefono', 'numero de telefono', 'abren', 'cierran', 'atienden', 'mapa', 'formas de pago', 'pago', 'pagos',
  'aceptan tarjeta', 'sinpe',
];

export function detectMenuIntent(text: string): MenuIntent | null {
  const norm = normalize(text);
  if (anyPhrase(norm, CITAS_WORDS)) return 'citas';
  if (anyPhrase(norm, SERVICIOS_WORDS)) return 'servicios';
  if (anyPhrase(norm, AGENDAR_WORDS)) return 'agendar';
  if (anyPhrase(norm, HORARIO_WORDS)) return 'horario';
  return null;
}

/** ¿El mensaje pide explícitamente una cita? (para no bloquear con el límite médico). */
export function wantsToBook(text: string): boolean {
  const norm = normalize(text);
  return anyPhrase(norm, ['cita', 'citas', 'agendar', 'reservar', 'sacar cita', 'apartar', 'agendo', 'agendame']);
}

// --- Médicos ---------------------------------------------------------------

/** Ids de los médicos del centro cuyo nombre o apellido aparece en el texto (sin contar "Dr."/"Dra."). */
export function matchDoctors(
  text: string,
  clinic: { especialidades: ReadonlyArray<{ medicos: ReadonlyArray<{ id: string; nombre: string }> }> },
): string[] {
  const norm = normalize(text);
  if (!norm) return [];
  return clinic.especialidades
    .flatMap((spec) => spec.medicos)
    .filter((doctor) =>
      normalize(doctor.nombre)
        .split(' ')
        .some((token) => token !== 'dr' && token !== 'dra' && token.length > 2 && hasPhrase(norm, token)),
    )
    .map((doctor) => doctor.id);
}

// --- Especialidades --------------------------------------------------------

/** Longitud del prefijo común de dos palabras. */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Coincidencia tolerante a variantes y errores de escritura: "cardiologica", "cardiologos" o "pediatrico"
 * comparten casi toda la raíz con la palabra clave. Solo palabras largas, para no confundir términos cortos.
 */
function fuzzyKeyMatch(tokens: readonly string[], key: string): boolean {
  if (key.includes(' ') || key.length < 7) return false;
  const needed = Math.max(6, key.length - 3);
  return tokens.some((t) => t.length >= 7 && commonPrefix(t, key) >= needed);
}

/** Especialidades cuyo nombre o palabras clave aparecen en el texto (con tolerancia a variantes si no hay coincidencia exacta). */
export function matchSpecialties<T extends Especialidad>(text: string, specialties: readonly T[]): T[] {
  const norm = normalize(text);
  if (!norm) return [];
  const keysOf = (spec: T): string[] => [spec.nombre, ...spec.palabrasClave].map(normalize).filter(Boolean);
  const exact = specialties.filter((spec) => keysOf(spec).some((key) => hasPhrase(norm, key)));
  if (exact.length > 0) return exact;
  const tokens = norm.split(' ');
  return specialties.filter((spec) => keysOf(spec).some((key) => fuzzyKeyMatch(tokens, key)));
}
