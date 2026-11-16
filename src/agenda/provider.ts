// Contrato de la agenda. Cualquier sistema (Google Calendar hoy, Siku mañana) debe cumplirlo.

export type ConfirmationMode = 'recepcion' | 'auto';
export type AppointmentStatus = 'por_confirmar' | 'confirmada';

/** Un espacio libre de un médico. `start`/`end` son ISO con desfase -06:00. */
export interface Slot {
  doctorId: string;
  date: string; // YYYY-MM-DD (Costa Rica)
  time: string; // HH:MM (Costa Rica)
  start: string;
  end: string;
}

export interface NewAppointment {
  doctorId: string;
  specialtyId: string;
  /** Inicio exacto de un Slot devuelto por getAvailableSlots. */
  start: string;
  patientName: string;
  phone: string;
  cedula?: string;
}

export interface Appointment {
  id: string;
  doctorId: string;
  specialtyId: string;
  date: string;
  time: string;
  start: string;
  end: string;
  patientName?: string;
  phone: string;
  status: AppointmentStatus;
}

export interface AgendaProvider {
  getAvailableSlots(doctorId: string, date: string /* YYYY-MM-DD */): Promise<Slot[]>;
  /** Lanza SlotTakenError si el espacio ya no está libre. */
  createAppointment(input: NewAppointment): Promise<Appointment>;
  /** Solo citas futuras. */
  listAppointments(phone: string): Promise<Appointment[]>;
  /** Lanza AppointmentNotFoundError si no existe o no pertenece a ese teléfono. */
  cancelAppointment(id: string, phone: string): Promise<void>;
}

export class SlotTakenError extends Error {
  constructor() {
    super('El espacio ya no está disponible');
    this.name = 'SlotTakenError';
  }
}

export class AppointmentNotFoundError extends Error {
  constructor() {
    super('La cita no existe o no pertenece a este teléfono');
    this.name = 'AppointmentNotFoundError';
  }
}

/** Fallo del sistema de agenda (red, permisos, respuesta inesperada). */
export class AgendaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgendaError';
  }
}
