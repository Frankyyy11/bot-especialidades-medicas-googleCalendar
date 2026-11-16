// Tipos compartidos entre el motor, WhatsApp y el simulador.

/** Mensaje entrante ya normalizado. */
export type Incoming =
  | { type: 'text'; text: string }
  /** Toque en un botón o fila de lista: `id` es el que enviamos nosotros. */
  | { type: 'choice'; id: string; title: string }
  /** Audio, imagen, documento, ubicación, etc. */
  | { type: 'unsupported'; kind: string };

export interface ButtonOption {
  id: string;
  title: string; // máx. 20 caracteres en WhatsApp
}

export interface ListRow {
  id: string;
  title: string; // máx. 24
  description?: string; // máx. 72
}

/** Respuesta saliente independiente del canal. */
export type Outgoing =
  | { type: 'text'; body: string }
  | { type: 'buttons'; body: string; buttons: ButtonOption[] } // máx. 3
  | { type: 'list'; body: string; buttonLabel: string; rows: ListRow[]; sectionTitle?: string }; // máx. 10 filas

export type State =
  | 'MENU'
  | 'AGENDAR_ESPECIALIDAD'
  | 'AGENDAR_MEDICO'
  | 'AGENDAR_DIA'
  | 'AGENDAR_HORA'
  | 'AGENDAR_NOMBRE'
  | 'AGENDAR_CEDULA'
  | 'AGENDAR_CONFIRMAR'
  | 'SERVICIOS_LISTA'
  | 'SERVICIOS_DETALLE'
  | 'CITAS_LISTA'
  | 'CITAS_CONFIRMAR'
  | 'HUMANO';

export interface Booking {
  especialidadId?: string;
  /** Id del médico elegido o 'any' para "cualquiera". */
  medicoId?: string;
  /** Médico concreto asignado al elegir la hora. */
  doctorId?: string;
  date?: string;
  time?: string;
  nombre?: string;
  cedula?: string;
  /** Paginación de días (offset en días desde hoy) y de horarios. */
  dayCursor: number;
  slotPage: number;
}

export interface Session {
  phone: string;
  state: State;
  greeted: boolean;
  /** Mensajes consecutivos no entendidos. */
  failures: number;
  booking: Booking;
  /** Cita seleccionada para cancelar. */
  cancelAppointmentId?: string;
}

export function newBooking(): Booking {
  return { dayCursor: 0, slotPage: 0 };
}

export function newSession(phone: string): Session {
  return { phone, state: 'MENU', greeted: false, failures: 0, booking: newBooking() };
}
