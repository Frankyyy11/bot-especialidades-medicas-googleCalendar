// Máquina de estados de la conversación.
// handleMessage(contexto, sesión, mensaje) -> { respuestas, nueva sesión }.
// No envía nada ni guarda nada: solo decide. Quien la llama (bot.ts) se encarga del resto.

import { logger } from '../util/logger.js';
import { isExit, isMedicalQuestion, isMenuWord, isUrgent, normalize, wantsHuman, wantsToBook } from './intents.js';
import { ID, M } from './messages.js';
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
import { applyAssist, FREE_TEXT_STATES, type Assist } from './states/assist.js';
import type { Incoming, Outgoing, Session } from './types.js';

export type { EngineContext } from './states/common.js';
export { planAi, type Assist, type AiPlan } from './states/assist.js';

export interface EngineResult {
  replies: Outgoing[];
  session: Session;
  /** true si el bot debe pausarse para esta conversación (pasa a recepción). */
  handoff: boolean;
  /** true si las reglas no entendieron el mensaje (candidato a la IA). */
  unresolved: boolean;
  /** Dónde puede ir la `respuestaBreve` de la IA (siempre antes del mensaje del código, nunca junto al "no entendido"). */
  briefSlot?: { insertAt: number };
}

export async function handleMessage(
  ctx: EngineContext,
  previous: Session,
  incoming: Incoming,
  assist?: Assist,
): Promise<EngineResult> {
  const s = structuredClone(previous);
  const replies: Outgoing[] = [];
  const firstContact = !s.greeted;
  if (firstContact) {
    replies.push(M.greeting(ctx.clinic, ctx.aiEnabled ?? false));
    s.greeted = true;
  }
  if (s.state === 'HUMANO') showMenu(s); // la pausa ya terminó: se retoma desde el menú

  let handoff = false;
  let unresolved = false;
  let briefSlot: EngineResult['briefSlot'];
  try {
    const outcome = await route(ctx, s, incoming, assist);
    handoff = outcome.handoff ?? false;
    unresolved = outcome.result === null;

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
      if (outcome.briefAllowed) briefSlot = { insertAt: replies.length };
      replies.push(...(outcome.result as Outgoing[]));
    }
  } catch (error) {
    // Nunca dejar al paciente sin respuesta.
    logger.error('engine_error', { phone: s.phone, state: s.state, error });
    showMenu(s);
    s.failures = 0;
    replies.push(M.genericError());
  }
  return { replies, session: s, handoff, unresolved, ...(briefSlot ? { briefSlot } : {}) };
}

interface Outcome {
  result: StepResult;
  handoff?: boolean;
  briefAllowed?: boolean;
}

/** Reglas globales (antes del estado actual) y luego despacho por estado. */
async function route(ctx: EngineContext, s: Session, incoming: Incoming, assist?: Assist): Promise<Outcome> {
  if (incoming.type === 'unsupported') return { result: [M.unsupported()] };

  if (incoming.type === 'choice' && incoming.id.startsWith('menu:')) {
    return routeMenuChoice(ctx, s, incoming.id.slice('menu:'.length));
  }
  // Botón "continuar" de una respuesta conversacional: vuelve a mostrar el paso en que estaba.
  if (incoming.type === 'choice' && incoming.id === ID.continuar) return { result: await reprompt(ctx, s) };

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

  // Solo si lo anterior no resolvió el mensaje (o hay más información que extraer): interpretación de la IA.
  if (assist && incoming.type === 'text') {
    const assisted = await applyAssist(ctx, s, incoming, assist);
    if (assisted) return assisted;
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
