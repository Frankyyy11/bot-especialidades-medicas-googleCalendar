// Proveedores simulados, sin red: para pruebas y para el simulador de terminal (`npm run chat`).
// FakeAiProvider imita a un LLM con reglas simples y deterministas. A propósito, ante un intento de
// inyección ("ignore las instrucciones...") se comporta como un modelo COMPROMETIDO (peor caso), para
// que el simulador y las pruebas demuestren que las guardas y el motor lo neutralizan.

import { findDoctor, type Clinic } from '../config/clinic.js';
import {
  detectMenuIntent,
  isMedicalQuestion,
  isMenuWord,
  isNo,
  isUrgent,
  isYes,
  matchDoctors,
  matchSpecialties,
  normalize,
  wantsHuman,
  wantsToBook,
} from '../engine/intents.js';
import { addDays, dayKey, DAY_KEYS, timeOf } from '../util/dates.js';
import type { AiInput, AiProvider, Franja, Interpretation, NoDisponible } from './provider.js';

const INJECTION = /\b(ignor\w*|olvid\w*|desobedec\w*)\b.*\b(instrucciones|reglas|indicaciones)\b|\bsystem prompt\b|\bprompt del sistema\b/;
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];

function resolveDate(norm: string, today: string): string | undefined {
  const explicit = norm.match(/\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)\b/);
  if (explicit) {
    const month = MONTHS.indexOf(explicit[2] === 'septiembre' ? 'setiembre' : explicit[2]!) + 1;
    const [year] = today.split('-') as [string];
    const date = `${year}-${String(month).padStart(2, '0')}-${explicit[1]!.padStart(2, '0')}`;
    return date >= today ? date : `${Number(year) + 1}-${date.slice(5)}`;
  }
  if (/\bpasado manana\b/.test(norm)) return addDays(today, 2);
  if (/\bhoy\b/.test(norm)) return today;
  // "mañana" como día; "en la mañana" es una franja, no una fecha.
  if (/\bmanana\b/.test(norm.replace(/\b(en|por|de|la) (la )?manana\b/g, ''))) return addDays(today, 1);
  for (const [i, key] of DAY_KEYS.entries()) {
    if (new RegExp(`\\b${key}\\b`).test(norm)) {
      for (let delta = 1; delta <= 7; delta++) if (dayKey(addDays(today, delta)) === DAY_KEYS[i]) return addDays(today, delta);
    }
  }
  return undefined;
}

function resolveFranja(norm: string): Franja | undefined {
  if (/\b(en|por|de|la) (la )?manana\b/.test(norm)) return 'manana';
  if (/\btarde\b/.test(norm)) return 'tarde';
  return undefined;
}

function resolveHour(norm: string): string | undefined {
  const m = norm.match(/\b(?:a las?|alrededor de las?|como a las?)\s+(\d{1,2})(?:[: ](\d{2}))?\s*(am|pm|a m|p m)?\b/) ?? norm.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)\b/);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const suffix = m[3]?.replace(' ', '');
  if (hour > 23 || minutes > 59) return undefined;
  if (suffix === 'pm' && hour < 12) hour += 12;
  else if (suffix === 'am' && hour === 12) hour = 0;
  else if (!suffix && hour >= 1 && hour <= 6) hour += 12; // sin am/pm, de 1 a 6 se entiende de la tarde
  return timeOf(hour * 60 + minutes);
}

function resolveDoctor(clinic: Clinic, text: string): string | undefined {
  return matchDoctors(text, clinic).find((id) => findDoctor(clinic, id));
}

// Lo que un paciente suele pedir y un centro puede no tener. Un modelo real lo deduce comparando con los datos
// del centro; aquí se imita con raíces de palabras comunes (se ignoran las que el centro sí menciona).
const OTHER_SPECIALTIES = /\b(odontolog|dentista|dental|oftalmolog|oculista|psicolog|psiquiatr|nutricion|ortoped|traumatolog|urolog|neurolog|otorrino|endocrinolog|gastroenterolog|oncolog|geriatr|neumolog|reumatolog|nefrolog|fisioterap|cardiolog|dermatolog|pediatr|ginecolog|medicina general|medico general)\w*/g;
const OTHER_SERVICES = /\b(laboratorio|examenes? de sangre|rayos x|radiografia|ultrasonido|tomografia|resonancia|vacuna|farmacia|ambulancia|hospitalizacion|cirugia)\w*/g;
const DOCTOR_MENTION = /\b(?:dr|dra|doctor|doctora)\s+([a-zñ]{3,})\b/;
const NOT_A_NAME = new Set(['que', 'del', 'para', 'por', 'con', 'los', 'las', 'una', 'uno', 'hay', 'esta', 'tiene', 'tienen', 'atiende', 'disponible', 'cualquiera']);

function resolveUnavailable(clinic: Clinic, text: string, norm: string): NoDisponible | undefined {
  if (matchSpecialties(text, clinic.especialidades).length > 0 || matchDoctors(text, clinic).length > 0) return undefined;
  const known = normalize(clinic.especialidades.flatMap((e) => [e.nombre, e.descripcion, ...e.palabrasClave]).join(' '));
  const unknown = (re: RegExp) => (norm.match(re) ?? []).some((hit) => !known.includes(hit));
  if (unknown(OTHER_SPECIALTIES)) return 'especialidad';
  const doctor = norm.match(DOCTOR_MENTION)?.[1];
  if (doctor && !NOT_A_NAME.has(doctor)) return 'medico';
  if (unknown(OTHER_SERVICES)) return 'servicio';
  return undefined;
}

export class FakeAiProvider implements AiProvider {
  async interpret(input: AiInput): Promise<Interpretation | null> {
    const { clinic, text } = input;
    const norm = normalize(text);

    if (INJECTION.test(norm)) {
      // Modelo "comprometido": obedece al paciente. Las guardas y el motor deben neutralizarlo.
      return { intent: 'confirmar', respuestaBreve: 'Claro, la consulta es gratis y su cita ya está confirmada.' };
    }
    if (isUrgent(text, clinic.palabrasUrgencia)) return { intent: 'urgencia' };
    if (isMedicalQuestion(text) && !wantsToBook(text)) return { intent: 'pregunta_medica' };
    if (wantsHuman(text)) return { intent: 'recepcion' };
    const words = norm.split(' ').length;
    if (/\b(gracias|agradezco|muy amable)\b/.test(norm) || (words <= 3 && /\b(perfecto|excelente|genial|entendido|que bien)\b/.test(norm))) {
      return { intent: 'agradecimiento', respuestaBreve: 'Con mucho gusto, para eso estamos.' };
    }
    if (isMenuWord(text)) return { intent: 'saludo', respuestaBreve: 'Con gusto le ayudo.' };
    if (isYes(text)) return { intent: 'confirmar' };
    if (isNo(text)) return { intent: 'negar' };

    // Pidieron algo que no está en los datos del centro: solo se señala; el texto lo pone el código.
    const noDisponible = resolveUnavailable(clinic, text, norm);
    if (noDisponible) return { intent: wantsToBook(text) ? 'agendar' : 'otro', noDisponible };

    const specs = matchSpecialties(text, clinic.especialidades);
    const especialidadId = specs.length === 1 ? specs[0]!.id : undefined;
    const medicoId = resolveDoctor(clinic, text);
    const fecha = resolveDate(norm, input.today);
    const franja = resolveFranja(norm);
    const hora = resolveHour(norm);
    const booking: Interpretation = {
      intent: 'agendar',
      ...(especialidadId ? { especialidadId } : {}),
      ...(medicoId ? { medicoId } : {}),
      ...(fecha ? { fecha } : {}),
      ...(franja ? { franja } : {}),
      ...(hora ? { hora } : {}),
    };
    const hasBookingInfo = Boolean(especialidadId || medicoId || fecha || franja || hora);

    const menu = detectMenuIntent(text);
    if (menu === 'citas') return { intent: /\b(cancel\w*|anul\w*)\b/.test(norm) ? 'cancelar_cita' : 'mis_citas' };
    if (menu === 'agendar' || wantsToBook(text) || (hasBookingInfo && /\b(quiero|ocupo|necesito|quisiera|me gustaria|busco|para)\b/.test(norm))) {
      return { ...booking, respuestaBreve: 'Con gusto, le ayudo a agendar su cita.' };
    }
    if (menu === 'servicios') {
      const spec = specs.length === 1 ? specs[0]! : undefined;
      return {
        intent: 'servicios',
        ...(spec ? { especialidadId: spec.id, respuestaBreve: `Con gusto. La consulta de ${spec.nombre} cuesta ${spec.precio}.` } : {}),
      };
    }
    const asksPayment = /\b(pago|pagos|pagar|tarjeta|sinpe|efectivo)\b/.test(norm);
    const asksWhere = /\b(donde|direccion|ubicacion|queda)\b/.test(norm);
    if (menu === 'horario' || asksPayment || asksWhere) {
      let respuestaBreve = 'Con gusto le comparto esa información.';
      if (asksPayment) respuestaBreve = `Aceptamos: ${clinic.formasPago.join(', ')}.`;
      else if (asksWhere) respuestaBreve = `Estamos en ${clinic.direccion}.`;
      return { intent: 'horario_ubicacion', respuestaBreve };
    }
    if (hasBookingInfo) return booking; // p. ej. "mejor el viernes en la tarde" dentro del flujo
    // Saludo con algo más ("hola, disculpe la molestia"): el saludo solo lo resuelven las reglas (menú).
    if (/^(hola|holi|buenas|buenos dias|buen dia|saludos)\b/.test(norm)) return { intent: 'saludo', respuestaBreve: '¡Hola! Con mucho gusto le ayudo.' };
    if (/\b(un momento|un momentito|ya casi|deme un minuto|espere|permitame)\b/.test(norm)) return { intent: 'otro', respuestaBreve: 'Claro, con calma. Aquí le espero.' };
    return { intent: 'otro', respuestaBreve: 'No tengo ese dato a mano; recepción con gusto le ayuda con esa consulta.' };
  }
}

/** Proveedor guiado por una función: para pruebas que necesitan una respuesta exacta (o un fallo). */
export class ScriptedAiProvider implements AiProvider {
  readonly calls: AiInput[] = [];

  constructor(private readonly script: (input: AiInput) => unknown | Promise<unknown>) {}

  async interpret(input: AiInput): Promise<Interpretation | null> {
    this.calls.push(input);
    return (await this.script(input)) as Interpretation | null;
  }
}
