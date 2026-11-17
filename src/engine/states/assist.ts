// Uso de la interpretación de la IA dentro del motor (SPEC-IA.md). El motor sigue siendo puro: recibe la
// interpretación ya validada (src/ai/guards.ts) y no importa nada de Gemini ni hace llamadas de red.
//
// Reglas que se hacen cumplir aquí:
//  - La IA solo puede AUMENTAR la cautela: urgencia / pregunta médica -> las mismas respuestas fijas.
//  - La IA no confirma ni cancela: "confirmar" y "negar" se ignoran; crear/cancelar exige el paso explícito.
//  - Los datos que ve el paciente salen de la configuración y de la agenda, nunca de la IA.

import type { Interpretation, NoDisponible } from '../../ai/provider.js';
import { findDoctor, findSpecialty } from '../../config/clinic.js';
import { detectMenuIntent, isExit, isMedicalQuestion, isMenuWord, isUrgent, matchDoctors, matchSpecialties, normalize, wantsHuman, wantsToBook } from '../intents.js';
import { M } from '../messages.js';
import type { Incoming, Outgoing, Session } from '../types.js';
import { startAppointments } from './appointments.js';
import { bookFromInterpretation } from './book.js';
import type { EngineContext, StepResult } from './common.js';
import { showMenu } from './common.js';
import { showHoursAndLocation } from './hours.js';
import { handOffToHuman } from './human.js';
import { showServiceDetail, startServices } from './services.js';

/** Estados donde el paciente escribe datos libres (nombre, cédula): la IA nunca se llama ahí. */
export const FREE_TEXT_STATES = new Set(['AGENDAR_NOMBRE', 'AGENDAR_CEDULA']);

/**
 * 'refine': las reglas entienden el mensaje pero puede traer más información (día, franja, hora): se pide
 *           la interpretación antes y solo se usa si es una reserva.
 * 'fallback': primero las reglas; la IA solo se consulta si no lograron resolver el mensaje.
 * 'skip': no se llama a la IA (no es texto, estado de datos personales, urgencia, límite médico, reglas globales).
 */
export type AiPlan = 'skip' | 'refine' | 'fallback';

const DATE_HINT = /\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|tarde|a las?|\d{1,2}(:\d{2})? ?(am|pm))\b/;

/** Pura y sin I/O. Replica el orden de seguridad: urgencias y límite médico por reglas ANTES de la IA. */
export function planAi(ctx: EngineContext, s: Session, incoming: Incoming): AiPlan {
  if (incoming.type !== 'text') return 'skip';
  const { text } = incoming;
  const norm = normalize(text);
  if (!norm || FREE_TEXT_STATES.has(s.state)) return 'skip';
  if (isUrgent(text, ctx.clinic.palabrasUrgencia) || wantsHuman(text) || isMenuWord(text)) return 'skip';
  if ((isExit(text) && s.state !== 'MENU') || norm === 'salir') return 'skip';
  if (isMedicalQuestion(text) && !wantsToBook(text)) return 'skip';

  const startsBooking = s.state === 'MENU' || s.state === 'HUMANO' || s.state === 'AGENDAR_ESPECIALIDAD';
  // Si el mensaje pide cita y trae más datos (día, franja, hora o varias palabras), se consulta la IA
  // antes, aunque las reglas no hayan reconocido la especialidad: así no se pierde lo que el paciente ya dijo.
  if (startsBooking && matchSpecialties(text, ctx.clinic.especialidades).length <= 1) {
    const bookingish = detectMenuIntent(text) === 'agendar' || wantsToBook(text);
    const hasSpecialty = matchSpecialties(text, ctx.clinic.especialidades).length === 1;
    if ((hasSpecialty || bookingish) && DATE_HINT.test(norm)) return 'refine';
    if (bookingish && norm.split(' ').length >= 5) return 'refine';
  }
  return 'fallback';
}

export interface Assist {
  interpretation: Interpretation;
  mode: 'refine' | 'fallback';
  /** La `respuestaBreve` ya pasó las guardas que no dependen del mensaje del código. */
  briefOk: boolean;
}

export interface AssistOutcome {
  result: StepResult;
  handoff?: boolean;
  /** Se puede anteponer la `respuestaBreve` (nunca en urgencia, límite médico, resumen ni confirmaciones). */
  briefAllowed?: boolean;
}

/** `undefined` = la interpretación no aporta: se sigue con las reglas. */
export async function applyAssist(
  ctx: EngineContext,
  s: Session,
  incoming: Incoming,
  assist: Assist,
): Promise<AssistOutcome | undefined> {
  let it = assist.interpretation;

  // La IA solo puede aumentar la cautela: respuestas fijas, sin `respuestaBreve`.
  if (it.intent === 'urgencia') return { result: handOffToHuman(ctx, s, true), handoff: true };
  if (it.intent === 'pregunta_medica') return { result: [M.medicalLimit()] };

  if (assist.mode === 'refine') {
    if (it.intent !== 'agendar' || incoming.type !== 'text') return undefined;
    // Las reglas ya identificaron la especialidad: la IA solo agrega día, franja y hora.
    const spec = matchSpecialties(incoming.text, ctx.clinic.especialidades)[0];
    if (!spec) return undefined;
    const medicoOk = it.medicoId && findDoctor(ctx.clinic, it.medicoId)?.specialty.id === spec.id;
    it = { ...it, especialidadId: spec.id };
    if (!medicoOk) delete it.medicoId;
  }

  const inBooking = s.state.startsWith('AGENDAR_');
  const inFlow = s.state !== 'MENU';
  const hasBookingInfo = Boolean(it.especialidadId || it.medicoId || it.fecha || it.franja || it.hora);
  const answered = (result: Outgoing[]): AssistOutcome => ({ result, briefAllowed: true });
  // Respuesta conversacional: la frase breve contesta y el paso actual se ofrece con un botón, sin repetir
  // la lista completa ni cambiar de estado. No cuenta como fallo.
  const keepGoing = (...before: Outgoing[]): AssistOutcome => answered([...before, M.continueStep(s.state)]);

  // Preguntaron por algo que el centro no ofrece. El texto sale de messages.ts con datos de la configuración;
  // la frase de la IA no se usa aquí. El paciente sigue en el mismo paso.
  const missing = assist.mode === 'fallback' && it.intent !== 'recepcion' ? unavailableKind(ctx, incoming, it) : undefined;
  if (missing) {
    const spec = inBooking && s.booking.especialidadId ? findSpecialty(ctx.clinic, s.booking.especialidadId) : undefined;
    return { result: [M.notOffered({ clinic: ctx.clinic, kind: missing, state: s.state, spec })] };
  }

  switch (it.intent) {
    case 'agendar':
      return answered(await bookFromInterpretation(ctx, s, it));
    case 'servicios': {
      const spec = it.especialidadId ? findSpecialty(ctx.clinic, it.especialidadId) : undefined;
      return answered(spec ? showServiceDetail(s, spec) : startServices(ctx, s));
    }
    case 'horario_ubicacion':
      // A mitad de un paso se contesta sin perder lo avanzado.
      return inFlow ? keepGoing(M.hours(ctx.clinic)) : answered(showHoursAndLocation(ctx, s));
    case 'mis_citas':
    case 'cancelar_cita':
      return answered(await startAppointments(ctx, s));
    case 'recepcion':
      return { result: handOffToHuman(ctx, s), handoff: true };
    case 'saludo':
      return inFlow ? keepGoing() : answered(showMenu(s));
    case 'agradecimiento':
      // Sin frase válida de la IA, el agradecimiento se contesta con el texto base.
      return keepGoing(...(assist.briefOk ? [] : [M.youAreWelcome()]));
    case 'otro':
      if (inBooking && hasBookingInfo) return answered(await bookFromInterpretation(ctx, s, it));
      // Pregunta general o comentario contestado por la frase breve.
      return assist.briefOk ? keepGoing() : undefined;
    case 'confirmar':
    case 'negar':
      // Crear o cancelar una cita exige el botón o el "sí" explícito: en esos pasos deciden las reglas.
      if (s.state === 'AGENDAR_CONFIRMAR' || s.state === 'CITAS_CONFIRMAR') return undefined;
      return assist.briefOk ? keepGoing() : undefined;
  }
}

/**
 * La IA dice que el paciente pidió algo que el centro no ofrece. Solo se le cree si la configuración no lo
 * contradice: si las reglas encuentran en el mensaje una especialidad o un médico que sí existe, se ignora.
 */
function unavailableKind(ctx: EngineContext, incoming: Incoming, it: Interpretation): NoDisponible | undefined {
  if (!it.noDisponible || incoming.type !== 'text' || it.especialidadId || it.medicoId) return undefined;
  if (matchSpecialties(incoming.text, ctx.clinic.especialidades).length > 0) return undefined;
  if (it.noDisponible === 'medico' && matchDoctors(incoming.text, ctx.clinic).length > 0) return undefined;
  return it.noDisponible;
}
