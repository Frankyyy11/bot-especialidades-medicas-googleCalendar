import { findSpecialty, type Specialty } from '../../config/clinic.js';
import { isYes, matchSpecialties, wantsToBook } from '../intents.js';
import { ID, M } from '../messages.js';
import { newBooking, type Incoming, type Outgoing, type Session } from '../types.js';
import { pickOption, resetFlow, type EngineContext, type StepResult } from './common.js';
import { startBooking } from './book.js';

export function startServices(ctx: EngineContext, s: Session): Outgoing[] {
  resetFlow(s);
  s.state = 'SERVICIOS_LISTA';
  return [M.servicesList(ctx.clinic)];
}

export function showServiceDetail(s: Session, spec: Specialty): Outgoing[] {
  s.booking = { ...newBooking(), especialidadId: spec.id };
  s.state = 'SERVICIOS_DETALLE';
  return [M.serviceDetail(spec)];
}

export function repromptServiceDetail(ctx: EngineContext, s: Session): Outgoing[] {
  const spec = s.booking.especialidadId ? findSpecialty(ctx.clinic, s.booking.especialidadId) : undefined;
  return spec ? [M.serviceDetail(spec)] : startServices(ctx, s);
}

export async function handleServicesList(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  const options = ctx.clinic.especialidades.map((e) => ({ id: ID.esp(e.id), keys: [e.nombre, ...e.palabrasClave] }));
  const picked = pickOption(incoming, options);
  if (!picked) return null;
  const spec = findSpecialty(ctx.clinic, picked.slice('esp:'.length));
  return spec ? showServiceDetail(s, spec) : null;
}

export async function handleServiceDetail(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  const specialtyId = s.booking.especialidadId;
  if (incoming.type === 'choice') {
    if (incoming.id === ID.serv.agendar && specialtyId) return startBooking(ctx, s, specialtyId);
    if (incoming.id === ID.serv.otras) return startServices(ctx, s);
    return null;
  }
  if (incoming.type === 'text') {
    if (specialtyId && (isYes(incoming.text) || wantsToBook(incoming.text))) return startBooking(ctx, s, specialtyId);
    const specs = matchSpecialties(incoming.text, ctx.clinic.especialidades);
    if (specs.length === 1) return showServiceDetail(s, specs[0]!);
  }
  return null;
}
