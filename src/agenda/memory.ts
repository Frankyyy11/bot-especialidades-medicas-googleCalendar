import { randomUUID } from 'node:crypto';
import { findDoctor, type Clinic } from '../config/clinic.js';
import { toCostaRica } from '../util/dates.js';
import {
  AgendaError,
  AppointmentNotFoundError,
  SlotTakenError,
  type AgendaProvider,
  type Appointment,
  type ConfirmationMode,
  type NewAppointment,
  type Slot,
} from './provider.js';
import { computeSlots, rangesFor, type BusyInterval } from './slots.js';

export interface MemoryAgendaOptions {
  clinic: Clinic;
  confirmationMode?: ConfirmationMode;
  now?: () => Date;
}

/** Agenda en memoria: para pruebas y para el simulador. Se pierde al reiniciar. */
export class MemoryAgendaProvider implements AgendaProvider {
  private readonly appointments = new Map<string, Appointment>();
  private readonly blocked: Array<{ doctorId: string } & BusyInterval> = [];
  private readonly clinic: Clinic;
  private readonly mode: ConfirmationMode;
  private readonly now: () => Date;

  constructor(options: MemoryAgendaOptions) {
    this.clinic = options.clinic;
    this.mode = options.confirmationMode ?? 'recepcion';
    this.now = options.now ?? (() => new Date());
  }

  /** Marca un intervalo como ocupado (simula una cita hecha por otro medio). Útil en pruebas. */
  block(doctorId: string, startIso: string, endIso: string): void {
    this.blocked.push({ doctorId, start: Date.parse(startIso), end: Date.parse(endIso) });
  }

  async getAvailableSlots(doctorId: string, date: string): Promise<Slot[]> {
    const found = findDoctor(this.clinic, doctorId);
    if (!found) throw new AgendaError(`Médico desconocido: ${doctorId}`);
    const busy: BusyInterval[] = [
      ...this.blocked.filter((b) => b.doctorId === doctorId),
      ...[...this.appointments.values()]
        .filter((a) => a.doctorId === doctorId)
        .map((a) => ({ start: Date.parse(a.start), end: Date.parse(a.end) })),
    ];
    return computeSlots({
      doctorId,
      date,
      ranges: rangesFor(found.doctor, date),
      duracionMin: found.specialty.duracionMin,
      busy,
      now: this.now(),
      rules: this.clinic,
    });
  }

  async createAppointment(input: NewAppointment): Promise<Appointment> {
    const found = findDoctor(this.clinic, input.doctorId);
    if (!found) throw new AgendaError(`Médico desconocido: ${input.doctorId}`);
    const startMs = Date.parse(input.start);
    const { date } = toCostaRica(new Date(startMs));
    const slots = await this.getAvailableSlots(input.doctorId, date);
    const slot = slots.find((s) => Date.parse(s.start) === startMs);
    if (!slot) throw new SlotTakenError();

    const appointment: Appointment = {
      id: `mem-${randomUUID()}`,
      doctorId: input.doctorId,
      specialtyId: input.specialtyId,
      date: slot.date,
      time: slot.time,
      start: slot.start,
      end: slot.end,
      patientName: input.patientName,
      phone: input.phone,
      status: this.mode === 'auto' ? 'confirmada' : 'por_confirmar',
    };
    this.appointments.set(appointment.id, appointment);
    return appointment;
  }

  async listAppointments(phone: string): Promise<Appointment[]> {
    const nowMs = this.now().getTime();
    return [...this.appointments.values()]
      .filter((a) => a.phone === phone && Date.parse(a.start) > nowMs)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async cancelAppointment(id: string, phone: string): Promise<void> {
    const appointment = this.appointments.get(id);
    if (!appointment || appointment.phone !== phone) throw new AppointmentNotFoundError();
    this.appointments.delete(id);
  }
}

