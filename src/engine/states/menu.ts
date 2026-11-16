import { detectMenuIntent, matchSpecialties, wantsToBook } from '../intents.js';
import type { Incoming, Outgoing, Session } from '../types.js';
import type { EngineContext, StepResult } from './common.js';
import { startBooking } from './book.js';
import { showServiceDetail, startServices } from './services.js';
import { startAppointments } from './appointments.js';
import { showHoursAndLocation } from './hours.js';

/** Texto libre en el menú: intención por palabras clave y atajo por especialidad. */
export async function handleMenuText(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  if (incoming.type !== 'text') return null;
  const intent = detectMenuIntent(incoming.text);
  const specs = matchSpecialties(incoming.text, ctx.clinic.especialidades);

  if (intent === 'citas') return startAppointments(ctx, s);

  if (specs.length === 1) {
    const spec = specs[0]!;
    if (intent === 'agendar' || wantsToBook(incoming.text)) return startBooking(ctx, s, spec.id);
    return showServiceDetail(s, spec);
  }

  switch (intent) {
    case 'agendar':
      return startBooking(ctx, s);
    case 'servicios':
      return startServices(ctx, s);
    case 'horario':
      return showHoursAndLocation(ctx, s);
    default:
      return null;
  }
}

/** Opciones del menú tocadas por id (también válidas desde cualquier estado). */
export async function handleMenuChoice(ctx: EngineContext, s: Session, option: string): Promise<Outgoing[] | null> {
  switch (option) {
    case 'agendar':
      return startBooking(ctx, s);
    case 'servicios':
      return startServices(ctx, s);
    case 'horario':
      return showHoursAndLocation(ctx, s);
    case 'citas':
      return startAppointments(ctx, s);
    default:
      return null;
  }
}

