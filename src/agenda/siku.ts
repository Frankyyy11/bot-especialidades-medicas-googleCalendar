import {
  type AgendaProvider,
  type Appointment,
  type NewAppointment,
  type Slot,
} from './provider.js';

const NOT_IMPLEMENTED =
  'SikuAgendaProvider no está implementado: se conectará cuando Siku entregue acceso a su API. Vea docs/SIKU.md.';

/**
 * Esqueleto para Siku. TODO: implementar los cuatro métodos cuando exista API.
 * Mientras tanto, use AGENDA_PROVIDER=google o memory.
 */
export class SikuAgendaProvider implements AgendaProvider {
  getAvailableSlots(_doctorId: string, _date: string): Promise<Slot[]> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  createAppointment(_input: NewAppointment): Promise<Appointment> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  listAppointments(_phone: string): Promise<Appointment[]> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
  cancelAppointment(_id: string, _phone: string): Promise<void> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
}
