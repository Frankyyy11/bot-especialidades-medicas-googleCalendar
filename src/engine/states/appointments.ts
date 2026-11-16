import { findDoctor, findSpecialty } from '../../config/clinic.js';
import { AppointmentNotFoundError, type Appointment } from '../../agenda/provider.js';
import { isNo, isYes } from '../intents.js';
import { appointmentRow, describeAppointment, ID, M } from '../messages.js';
import type { Incoming, Outgoing, Session } from '../types.js';
import { resetFlow, type EngineContext, type StepResult } from './common.js';

function detailOf(ctx: EngineContext, a: Appointment): string {
  const found = findDoctor(ctx.clinic, a.doctorId);
  return describeAppointment(a, found?.specialty ?? findSpecialty(ctx.clinic, a.specialtyId), found?.doctor);
}

export async function startAppointments(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  resetFlow(s);
  const list = (await ctx.agenda.listAppointments(s.phone)).slice(0, 10);
  if (list.length === 0) return [M.noAppointments()];
  s.state = 'CITAS_LISTA';
  return [
    M.appointmentsList(
      list.map((a) => {
        const found = findDoctor(ctx.clinic, a.doctorId);
        return appointmentRow(a, found?.specialty ?? findSpecialty(ctx.clinic, a.specialtyId), found?.doctor);
      }),
    ),
  ];
}

export async function repromptAppointmentsList(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  return startAppointments(ctx, s);
}

export async function repromptCancelConfirm(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  const appointment = (await ctx.agenda.listAppointments(s.phone)).find((a) => a.id === s.cancelAppointmentId);
  if (!appointment) return startAppointments(ctx, s);
  return [M.confirmCancel(detailOf(ctx, appointment))];
}

export async function handleAppointmentsList(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  if (incoming.type !== 'choice' || !incoming.id.startsWith('cita:')) return null;
  const id = incoming.id.slice('cita:'.length);
  const appointment = (await ctx.agenda.listAppointments(s.phone)).find((a) => a.id === id);
  if (!appointment) return [M.appointmentNotFound()];
  s.cancelAppointmentId = appointment.id;
  s.state = 'CITAS_CONFIRMAR';
  return [M.confirmCancel(detailOf(ctx, appointment))];
}

export async function handleCancelConfirm(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  const yes = (incoming.type === 'choice' && incoming.id === ID.citas.si) || (incoming.type === 'text' && isYes(incoming.text));
  const no = (incoming.type === 'choice' && incoming.id === ID.citas.no) || (incoming.type === 'text' && isNo(incoming.text));

  if (no) {
    resetFlow(s);
    return [M.kept(), M.menu()];
  }
  if (!yes || !s.cancelAppointmentId) return null;

  const id = s.cancelAppointmentId;
  const appointment = (await ctx.agenda.listAppointments(s.phone)).find((a) => a.id === id);
  try {
    await ctx.agenda.cancelAppointment(id, s.phone);
  } catch (error) {
    if (error instanceof AppointmentNotFoundError) {
      resetFlow(s);
      return [M.appointmentNotFound()];
    }
    throw error;
  }
  resetFlow(s);
  return [M.cancelled(appointment ? detailOf(ctx, appointment) : 'La cita indicada')];
}
