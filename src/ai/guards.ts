// Validación y guardas (SPEC-IA.md sección 2). Todo lo que sale de la IA es no confiable:
// se valida campo por campo y se descarta lo que no cuadra con la configuración del centro.
// Funciones puras, sin red.

import { z } from 'zod';
import type { Clinic } from '../config/clinic.js';
import { findDoctor, findSpecialty } from '../config/clinic.js';
import { isMedicalQuestion, isUrgent, normalize } from '../engine/intents.js';
import type { Outgoing } from '../engine/types.js';
import { addDays, DATE_RE, TIME_RE } from '../util/dates.js';
import { AI_INTENTS, NO_DISPONIBLE, type Interpretation } from './provider.js';

export const MAX_BRIEF_CHARS = 300;

// --- Estructura (zod) ---------------------------------------------------------

/** Cada campo opcional inválido se descarta solo (`catch`); un `intent` inválido invalida todo. */
const optionalField = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const rawSchema = z.object({
  intent: z.enum(AI_INTENTS),
  especialidadId: optionalField(z.string().min(1).max(80)),
  medicoId: optionalField(z.string().min(1).max(80)),
  fecha: optionalField(z.string().regex(DATE_RE)),
  franja: optionalField(z.enum(['manana', 'tarde'])),
  hora: optionalField(z.string().regex(TIME_RE)),
  noDisponible: optionalField(z.enum(NO_DISPONIBLE)),
  respuestaBreve: optionalField(z.string().max(2000)),
});

/** Estructura mínima. `null` si no es un objeto con un `intent` conocido. */
export function parseInterpretation(raw: unknown): Interpretation | null {
  const result = rawSchema.safeParse(raw);
  if (!result.success) return null;
  const out: Interpretation = { intent: result.data.intent };
  const { especialidadId, medicoId, fecha, franja, hora, noDisponible, respuestaBreve } = result.data;
  if (especialidadId) out.especialidadId = especialidadId;
  if (medicoId) out.medicoId = medicoId;
  if (fecha) out.fecha = fecha;
  if (franja) out.franja = franja;
  if (hora) out.hora = hora;
  if (noDisponible) out.noDisponible = noDisponible;
  if (respuestaBreve) out.respuestaBreve = respuestaBreve;
  return out;
}

export interface ConstraintContext {
  clinic: Clinic;
  /** Hoy en Costa Rica (YYYY-MM-DD). */
  today: string;
}

function isRealDate(date: string): boolean {
  return addDays(date, 0) === date; // fechas como 2026-02-31 no sobreviven al ida y vuelta
}

/** Descarta, campo por campo, ids desconocidos y fechas pasadas, inexistentes o fuera de rango. */
export function constrainInterpretation(it: Interpretation, ctx: ConstraintContext): Interpretation {
  const out: Interpretation = { intent: it.intent };
  const { clinic, today } = ctx;

  let especialidadId = it.especialidadId && findSpecialty(clinic, it.especialidadId) ? it.especialidadId : undefined;
  let medicoId: string | undefined;
  if (it.medicoId) {
    const found = findDoctor(clinic, it.medicoId);
    if (found && (!especialidadId || found.specialty.id === especialidadId)) {
      medicoId = found.doctor.id;
      especialidadId ??= found.specialty.id; // el médico determina la especialidad
    }
  }
  if (especialidadId) out.especialidadId = especialidadId;
  if (medicoId) out.medicoId = medicoId;

  if (it.fecha && DATE_RE.test(it.fecha) && isRealDate(it.fecha) && it.fecha >= today && it.fecha <= addDays(today, clinic.diasMaxAdelanto)) {
    out.fecha = it.fecha;
  }
  if (it.franja === 'manana' || it.franja === 'tarde') out.franja = it.franja;
  if (it.hora && TIME_RE.test(it.hora)) out.hora = it.hora;
  // Si la IA dio un id válido, lo pedido sí existe: la señal de "no disponible" se contradice y se descarta.
  if (it.noDisponible && NO_DISPONIBLE.includes(it.noDisponible) && !especialidadId && !medicoId) out.noDisponible = it.noDisponible;
  if (it.respuestaBreve) out.respuestaBreve = it.respuestaBreve;
  return out;
}

/** Estructura + restricciones. `null` si no hay interpretación utilizable. */
export function validateInterpretation(raw: unknown, ctx: ConstraintContext): Interpretation | null {
  const parsed = parseInterpretation(raw);
  return parsed ? constrainInterpretation(parsed, ctx) : null;
}

// --- Guardas de `respuestaBreve` ------------------------------------------------

/** Patrones clínicos de SALIDA que la IA nunca debe producir (medicamentos, dosis, diagnósticos, consejos). */
export const FORBIDDEN_OUTPUT_PATTERNS: RegExp[] = [
  /\b(paracetamol|acetaminofen|ibuprofeno|aspirina|naproxeno|diclofenaco|amoxicilina|azitromicina|omeprazol|loratadina|cetirizina|metformina|losartan|insulina|tramadol|prednisona|dolex|advil|tylenol)\b/,
  /\b(antibiotico|antibioticos|analgesico|analgesicos|antiinflamatorio|antiinflamatorios|jarabe|pomada|inyeccion|medicamento|medicamentos|pastilla|pastillas|tableta|tabletas|capsula|capsulas)\b/,
  /\b\d+(?:[.,]\d+)?\s?(mg|ml|mcg|gramos|miligramos|gotas)\b/,
  /\b(dosis|posologia|receta|recetar|recete)\b/,
  /\b(le recomiendo|te recomiendo|le sugiero|le aconsejo)\b/,
  /\b(debe|puede|podria|deberia|tiene que|necesita)\s+(tomar|ingerir|aplicarse|descansar|hidratarse|tomarse)\b/,
  /\b(tome|tomese|ingiera|aplique|apliquese|descanse|hidratese|reposo|repose|haga reposo)\b/,
  /\b(podria ser|puede ser|probablemente (es|sea|tiene)|parece (ser|una|un)|seguramente es|se trata de|sufre de|padece)\b/,
  /\b(diagnostico|diagnosticar|sintoma|sintomas|enfermedad|infeccion|alergia|gripe|fiebre|hipertension|diabetes)\b/,
  /\b(tratar|tratamiento|tratamientos|curar|curacion|cura|sanar)\b/,
  /\b(no se preocupe|no es grave|nada grave|no tiene importancia|es normal|esta tranquilo|tranquilo)\b/,
];

/** Frases de promesa o compromiso que la IA no puede hacer: solo el código confirma, cancela o contacta. */
export const FORBIDDEN_PROMISE_PATTERNS: RegExp[] = [
  /\bcita (confirmada|reservada|agendada|programada|cancelada|asegurada)\b/,
  /\bsu cita (esta|queda|quedo|fue|ha sido|ya esta|ya fue|ya quedo)\b/,
  /\b(ya|he|hemos)\s+(agend|reserv|cancel|confirm|program)/,
  /\b(agende|reserve|cancele|confirme|programe)\b/,
  /\bse (agendo|reservo|cancelo|confirmo|programo)\b/,
  /\ble (llamaremos|llamamos|llamare|llamo|contactaremos|contactare|escribiremos|escribire|enviaremos|enviare|avisaremos|avisare|confirmaremos|confirmare|garantizo|garantizamos|prometo|prometemos|aseguro|aseguramos)\b/,
  /\b(garantizad|asegurad)/,
  /\b(gratis|gratuit|sin costo|sin cargo|sin cobro|no tiene costo|no cuesta|descuento|promocion|oferta|rebaja|cortesia|exonerad)/,
];

const LINK_PATTERN = /(https?:\/\/|www\.|wa\.me|\b[a-z0-9-]+\.(com|cr|net|org|io|me|app|link)\b)/i;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
/** Números escritos con letras (no se pueden cotejar con los datos del centro, así que se rechazan). */
const NUMBER_WORDS = /\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|cientos|mil|millon|millones)\b/;

/** Secuencias numéricas ("8:00", "35 000", "2222-0000") normalizadas para compararlas. */
function numberGroups(text: string): string[] {
  // Solo espacio (normal, duro o fino), punto, coma, dos puntos y guion unen dígitos; el salto de línea no.
  const groups = text.match(/\d+(?:[ .,:\-\xA0\u202F]\d+)*/g) ?? [];
  const out: string[] = [];
  const clean = (g: string) => g.replace(/[ .,\-\xA0\u202F]/g, '');
  for (const g of groups) {
    out.push(clean(g));
    // Rangos y teléfonos: también valen sus partes ("8:00-17:00" -> "8:00" y "17:00").
    for (const part of g.split('-')) out.push(clean(part));
  }
  return out.filter(Boolean);
}

/** Texto público del centro: la única fuente de datos permitida para la IA. */
export function clinicFacts(clinic: Clinic): string {
  return [
    clinic.nombre,
    clinic.direccion,
    clinic.telefono,
    clinic.horarioGeneral.join(' '),
    clinic.formasPago.join(' '),
    ...clinic.especialidades.flatMap((e) => [
      e.nombre,
      e.descripcion,
      e.precio,
      `${e.duracionMin} minutos`,
      ...e.medicos.map((m) => m.nombre),
    ]),
  ].join('\n');
}

/** Texto plano de lo que el código ya va a enviar (para cotejar números de la `respuestaBreve`). */
export function outgoingText(replies: readonly Outgoing[]): string {
  return replies
    .map((r) => {
      if (r.type === 'text') return r.body;
      if (r.type === 'buttons') return `${r.body}\n${r.buttons.map((b) => b.title).join(' ')}`;
      return `${r.body}\n${r.rows.map((x) => `${x.title} ${x.description ?? ''}`).join(' ')}`;
    })
    .join('\n');
}

export type BriefRejection = 'vacia' | 'longitud' | 'enlace' | 'emoji' | 'numero' | 'clinico' | 'promesa';

export interface BriefVerdict {
  ok: boolean;
  text?: string;
  reason?: BriefRejection;
}

/**
 * Guardas de `respuestaBreve`. Si falla cualquiera, se descarta y solo sale la plantilla.
 * `deterministicText`: el texto que el código ya enviará junto a la frase (sus números son válidos).
 */
export function guardBrief(brief: string | undefined, clinic: Clinic, deterministicText = ''): BriefVerdict {
  const text = (brief ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'vacia' };
  if ([...text].length > MAX_BRIEF_CHARS) return { ok: false, reason: 'longitud' };
  if (LINK_PATTERN.test(text)) return { ok: false, reason: 'enlace' };
  if (EMOJI_PATTERN.test(text)) return { ok: false, reason: 'emoji' };

  const norm = normalize(text);
  if (FORBIDDEN_PROMISE_PATTERNS.some((re) => re.test(norm))) return { ok: false, reason: 'promesa' };
  if (FORBIDDEN_OUTPUT_PATTERNS.some((re) => re.test(norm)) || isMedicalQuestion(text) || isUrgent(text, clinic.palabrasUrgencia)) {
    return { ok: false, reason: 'clinico' };
  }

  // Todo número (horas, precios, teléfonos, fechas) debe existir en los datos del centro o en el mensaje del código.
  const allowed = new Set(numberGroups(`${clinicFacts(clinic)}\n${deterministicText}`));
  if (NUMBER_WORDS.test(norm) || numberGroups(text).some((g) => !allowed.has(g))) return { ok: false, reason: 'numero' };

  return { ok: true, text };
}
