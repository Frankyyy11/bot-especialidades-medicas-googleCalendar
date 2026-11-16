// Máquina de estados de la conversación.
// handleMessage(contexto, sesión, mensaje) -> { respuestas, nueva sesión }.
// No envía nada ni guarda nada: solo decide. Quien la llama (bot.ts) se encarga del resto.

import { logger } from '../util/logger.js';
import { isExit, isMedicalQuestion, isMenuWord, isUrgent, normalize, wantsHuman, wantsToBook } from './intents.js';
import { M } from './messages.js';
import {
  handleDay,
  handleDoctor,
  handleHour,
  handleName,
  handleCedula,
  handleConfirm,
  handleSpecialty,
  repromptCedula,
  repromptDay,
  repromptDoctor,
  repromptHour,
  repromptName,
  repromptSpecialty,
  repromptSummary,
} from './states/book.js';
import {
  handleAppointmentsList,
  handleCancelConfirm,
  repromptAppointmentsList,
  repromptCancelConfirm,
} from './states/appointments.js';
import { abandonFlow, showMenu, type EngineContext, type StepResult } from './states/common.js';
import { handOffToHuman } from './states/human.js';
import { handleMenuChoice, handleMenuText } from './states/menu.js';
import { handleServiceDetail, handleServicesList, repromptServiceDetail, startServices } from './states/services.js';
import type { Incoming, Outgoing, Session } from './types.js';

export type { EngineContext } from './states/common.js';

export interface EngineResult {
  replies: Outgoing[];
  session: Session;
  /** true si el bot debe pausarse para esta conversación (pasa a recepción). */
  handoff: boolean;
}

/** Estados donde el paciente escribe datos libres: no se aplican las reglas de intención médica. */
const FREE_TEXT_STATES = new Set(['AGENDAR_NOMBRE', 'AGENDAR_CEDULA']);

export async function handleMessage(ctx: EngineContext, previous: Session, incoming: Incoming): Promise<EngineResult> {
  const s = structuredClone(previous);
  const replies: Outgoing[] = [];
  const firstContact = !s.greeted;
  if (firstContact) {
    replies.push(M.greeting(ctx.clinic));
    s.greeted = true;
  }
  if (s.state === 'HUMANO') showMenu(s); // la pausa ya terminó: se retoma desde el menú

  let handoff = false;
  try {
    const outcome = await route(ctx, s, incoming);
    handoff = outcome.handoff ?? false;

    if (outcome.result === null || 'retry' in (outcome.result as object)) {
      if (outcome.result === null && firstContact) {
        // Primer mensaje sin intención clara (p. ej. "buenas"): se muestra el menú sin contar como fallo.
        replies.push(...showMenu(s));
      } else {
        s.failures += 1;
        if (s.failures >= 2) replies.push(M.offerHuman());
        else if (outcome.result === null) replies.push(M.notUnderstood(), ...(await reprompt(ctx, s)));
        else replies.push(...(outcome.result as { retry: Outgoing[] }).retry);
      }
    } else {
      s.failures = 0;
      replies.push(...(outcome.result as Outgoing[]));
    }
  } catch (error) {
    // Nunca dejar al paciente sin respuesta.
    logger.error('engine_error', { phone: s.phone, state: s.state, error });
    showMenu(s);
    s.failures = 0;
    replies.push(M.genericError());
  }
  return { replies, session: s, handoff };
}

interface Outcome {
  result: StepResult;
  handoff?: boolean;
}

/** Reglas globales (antes del estado actual) y luego despacho por estado. */
async function route(ctx: EngineContext, s: Session, incoming: Incoming): Promise<Outcome> {
  if (incoming.type === 'unsupported') return { result: [M.unsupported()] };

  if (incoming.type === 'choice' && incoming.id.startsWith('menu:')) {
    return routeMenuChoice(ctx, s, incoming.id.slice('menu:'.length));
  }

  if (incoming.type === 'text') {
    const { text } = incoming;
    if (isUrgent(text, ctx.clinic.palabrasUrgencia)) return { result: handOffToHuman(ctx, s, true), handoff: true };
    if (wantsHuman(text)) return { result: handOffToHuman(ctx, s), handoff: true };
    if (isMenuWord(text)) return { result: showMenu(s) };
    if (isExit(text) && s.state !== 'MENU') return { result: abandonFlow(s) };
    if (normalize(text) === 'salir') return { result: [M.despedida()] };
    if (!FREE_TEXT_STATES.has(s.state) && isMedicalQuestion(text) && !wantsToBook(text)) {
      return { result: [M.medicalLimit()] };
    }
  }

  return { result: await dispatch(ctx, s, incoming) };
}

async function routeMenuChoice(ctx: EngineContext, s: Session, option: string): Promise<Outcome> {
  if (option === 'recepcion') return { result: handOffToHuman(ctx, s), handoff: true };
  if (option === 'menu') return { result: showMenu(s) };
  return { result: await handleMenuChoice(ctx, s, option) };
}

async function dispatch(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  switch (s.state) {
    case 'AGENDAR_ESPECIALIDAD':
      return handleSpecialty(ctx, s, incoming);
    case 'AGENDAR_MEDICO':
      return handleDoctor(ctx, s, incoming);
    case 'AGENDAR_DIA':
      return handleDay(ctx, s, incoming);
    case 'AGENDAR_HORA':
      return handleHour(ctx, s, incoming);
    case 'AGENDAR_NOMBRE':
      return handleName(ctx, s, incoming);
    case 'AGENDAR_CEDULA':
      return handleCedula(ctx, s, incoming);
    case 'AGENDAR_CONFIRMAR':
      return handleConfirm(ctx, s, incoming);
    case 'SERVICIOS_LISTA':
      return handleServicesList(ctx, s, incoming);
    case 'SERVICIOS_DETALLE':
      return handleServiceDetail(ctx, s, incoming);
    case 'CITAS_LISTA':
      return handleAppointmentsList(ctx, s, incoming);
    case 'CITAS_CONFIRMAR':
      return handleCancelConfirm(ctx, s, incoming);
    case 'MENU':
    case 'HUMANO':
      return handleMenuText(ctx, s, incoming);
  }
}

/** Vuelve a mostrar la pregunta del estado actual (tras un mensaje no entendido). */
async function reprompt(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  switch (s.state) {
    case 'AGENDAR_ESPECIALIDAD':
      return repromptSpecialty(ctx);
    case 'AGENDAR_MEDICO':
      return repromptDoctor(ctx, s);
    case 'AGENDAR_DIA':
      return repromptDay(ctx, s);
    case 'AGENDAR_HORA':
      return repromptHour(ctx, s);
    case 'AGENDAR_NOMBRE':
      return repromptName();
    case 'AGENDAR_CEDULA':
      return repromptCedula();
    case 'AGENDAR_CONFIRMAR':
      return repromptSummary(ctx, s);
    case 'SERVICIOS_LISTA':
      return startServices(ctx, s);
    case 'SERVICIOS_DETALLE':
      return repromptServiceDetail(ctx, s);
    case 'CITAS_LISTA':
      return repromptAppointmentsList(ctx, s);
    case 'CITAS_CONFIRMAR':
      return repromptCancelConfirm(ctx, s);
    case 'MENU':
    case 'HUMANO':
      return showMenu(s);
  }
}
