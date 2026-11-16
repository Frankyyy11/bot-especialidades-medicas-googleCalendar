import { GoogleAuth } from 'google-auth-library';
import { findDoctor, type Clinic } from '../config/clinic.js';
import { TIME_ZONE, toCostaRica } from '../util/dates.js';
import {
  AgendaError,
  AppointmentNotFoundError,
  SlotTakenError,
  type AgendaProvider,
  type Appointment,
  type AppointmentStatus,
  type ConfirmationMode,
  type NewAppointment,
  type Slot,
} from './provider.js';
import { computeSlots, dayWindow, rangesFor, type BusyInterval } from './slots.js';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
export const PENDING_PREFIX = '[POR CONFIRMAR] ';

export interface GoogleCalendarOptions {
  clinic: Clinic;
  getAccessToken: () => Promise<string>;
  confirmationMode?: ConfirmationMode;
  fetchFn?: typeof fetch;
  now?: () => Date;
  retryDelayMs?: number;
}

/** Token de acceso a partir de una cuenta de servicio (archivo o JSON en variable de entorno). */
export function createServiceAccountTokenProvider(source: { file?: string; json?: string }): () => Promise<string> {
  let auth: GoogleAuth;
  if (source.json) {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(source.json) as Record<string, unknown>;
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido.');
    }
    auth = new GoogleAuth({ credentials, scopes: [SCOPE] });
  } else if (source.file) {
    auth = new GoogleAuth({ keyFile: source.file, scopes: [SCOPE] });
  } else {
    throw new Error('Con AGENDA_PROVIDER=google defina GOOGLE_SERVICE_ACCOUNT_FILE o GOOGLE_SERVICE_ACCOUNT_JSON.');
  }
  return async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new AgendaError('No se pudo obtener el token de Google');
    return token;
  };
}

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export class GoogleCalendarProvider implements AgendaProvider {
  private readonly clinic: Clinic;
  private readonly getAccessToken: () => Promise<string>;
  private readonly mode: ConfirmationMode;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;

  constructor(options: GoogleCalendarOptions) {
    this.clinic = options.clinic;
    this.getAccessToken = options.getAccessToken;
    this.mode = options.confirmationMode ?? 'recepcion';
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 400;
  }

  async getAvailableSlots(doctorId: string, date: string): Promise<Slot[]> {
    const { doctor, specialty, calendarId } = this.resolveDoctor(doctorId);
    const base = {
      doctorId,
      date,
      ranges: rangesFor(doctor, date),
      duracionMin: specialty.duracionMin,
      now: this.now(),
      rules: this.clinic,
    };
    // Sin horario, feriado o fuera de rango: no hace falta consultar a Google.
    if (computeSlots({ ...base, busy: [] }).length === 0) return [];
    const busy = await this.freeBusy(calendarId, date);
    return computeSlots({ ...base, busy });
  }

  async createAppointment(input: NewAppointment): Promise<Appointment> {
    const { specialty, calendarId } = this.resolveDoctor(input.doctorId);
    const startMs = Date.parse(input.start);
    const { date } = toCostaRica(new Date(startMs));

    // Verificación final justo antes de escribir (otra persona pudo ocupar el espacio).
    const slots = await this.getAvailableSlots(input.doctorId, date);
    const slot = slots.find((s) => Date.parse(s.start) === startMs);
    if (!slot) throw new SlotTakenError();

    const pending = this.mode === 'recepcion';
    const description = [
      `Paciente: ${input.patientName}`,
      `Teléfono: ${input.phone}`,
      ...(input.cedula ? [`Cédula: ${input.cedula}`] : []),
      'Solicitada por el bot de WhatsApp.',
    ].join('\n');

    const event = await this.request<CalendarEvent>('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {
      body: {
        summary: `${pending ? PENDING_PREFIX : ''}${specialty.nombre} – ${input.patientName}`,
        description,
        start: { dateTime: slot.start, timeZone: TIME_ZONE },
        end: { dateTime: slot.end, timeZone: TIME_ZONE },
        extendedProperties: {
          private: {
            phone: input.phone,
            doctorId: input.doctorId,
            specialtyId: input.specialtyId,
            source: 'bot',
          },
        },
      },
    });
    if (!event?.id) throw new AgendaError('Google no devolvió el id del evento');

    return {
      id: `${input.doctorId}:${event.id}`,
      doctorId: input.doctorId,
      specialtyId: input.specialtyId,
      date: slot.date,
      time: slot.time,
      start: slot.start,
      end: slot.end,
      patientName: input.patientName,
      phone: input.phone,
      status: pending ? 'por_confirmar' : 'confirmada',
    };
  }

  async listAppointments(phone: string): Promise<Appointment[]> {
    const calendars = new Map<string, string>(); // calendarId -> doctorId (primero que lo usa)
    for (const specialty of this.clinic.especialidades) {
      for (const doctor of specialty.medicos) {
        if (doctor.calendarId && !calendars.has(doctor.calendarId)) calendars.set(doctor.calendarId, doctor.id);
      }
    }

    const lists = await Promise.all(
      [...calendars.entries()].map(async ([calendarId, fallbackDoctorId]) => {
        const response = await this.request<{ items?: CalendarEvent[] }>(
          'GET',
          `/calendars/${encodeURIComponent(calendarId)}/events`,
          {
            query: {
              privateExtendedProperty: `phone=${phone}`,
              timeMin: this.now().toISOString(),
              singleEvents: 'true',
              orderBy: 'startTime',
              maxResults: '50',
            },
          },
        );
        return (response?.items ?? [])
          .map((event) => this.toAppointment(event, fallbackDoctorId, phone))
          .filter((a): a is Appointment => a !== undefined);
      }),
    );
    return lists.flat().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async cancelAppointment(id: string, phone: string): Promise<void> {
    const separator = id.indexOf(':');
    if (separator < 1) throw new AppointmentNotFoundError();
    const doctorId = id.slice(0, separator);
    const eventId = id.slice(separator + 1);
    const found = findDoctor(this.clinic, doctorId);
    if (!found?.doctor.calendarId) throw new AppointmentNotFoundError();
    const path = `/calendars/${encodeURIComponent(found.doctor.calendarId)}/events/${encodeURIComponent(eventId)}`;

    const event = await this.request<CalendarEvent>('GET', path, { allowNotFound: true });
    if (!event || event.extendedProperties?.private?.phone !== phone) throw new AppointmentNotFoundError();
    await this.request('DELETE', path, { allowNotFound: true });
  }

  // --- internos ---

  private resolveDoctor(doctorId: string) {
    const found = findDoctor(this.clinic, doctorId);
    if (!found) throw new AgendaError(`Médico desconocido: ${doctorId}`);
    if (!found.doctor.calendarId) throw new AgendaError(`El médico ${doctorId} no tiene calendarId en la configuración`);
    return { ...found, calendarId: found.doctor.calendarId };
  }

  private async freeBusy(calendarId: string, date: string): Promise<BusyInterval[]> {
    const { timeMin, timeMax } = dayWindow(date);
    const response = await this.request<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>;
    }>('POST', '/freeBusy', {
      body: { timeMin, timeMax, timeZone: TIME_ZONE, items: [{ id: calendarId }] },
    });
    const entry = response?.calendars?.[calendarId];
    if (!entry || (entry.errors && entry.errors.length > 0)) {
      throw new AgendaError('freeBusy no pudo leer el calendario (¿está compartido con la cuenta de servicio?)');
    }
    return (entry.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  }

  private toAppointment(event: CalendarEvent, fallbackDoctorId: string, phone: string): Appointment | undefined {
    const startIso = event.start?.dateTime;
    const endIso = event.end?.dateTime;
    if (!startIso || !endIso) return undefined;
    const props = event.extendedProperties?.private ?? {};
    const doctorId = props.doctorId ?? fallbackDoctorId;
    const start = toCostaRica(new Date(startIso));
    const status: AppointmentStatus = event.summary?.startsWith(PENDING_PREFIX.trim()) ? 'por_confirmar' : 'confirmada';
    const patientName = event.description?.match(/^Paciente: (.+)$/m)?.[1];
    return {
      id: `${doctorId}:${event.id}`,
      doctorId,
      specialtyId: props.specialtyId ?? '',
      date: start.date,
      time: start.time,
      start: startIso,
      end: endIso,
      ...(patientName ? { patientName } : {}),
      phone,
      status,
    };
  }

  /** Llamada REST con un reintento simple ante errores de red, 429 o 5xx. */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { query?: Record<string, string>; body?: unknown; allowNotFound?: boolean } = {},
  ): Promise<T | undefined> {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));

      let response: Response;
      try {
        const token = await this.getAccessToken();
        response = await this.fetchFn(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (error) {
        lastError = error; // fallo de red o de autenticación: se reintenta una vez
        continue;
      }

      if (response.status === 404 && options.allowNotFound) return undefined;
      if (response.status === 429 || response.status >= 500) {
        lastError = new AgendaError(`Google Calendar respondió ${response.status}`);
        continue;
      }
      if (!response.ok) throw new AgendaError(`Google Calendar respondió ${response.status}`);
      if (response.status === 204) return undefined;
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : undefined;
    }
    throw lastError instanceof Error ? lastError : new AgendaError('Error desconocido al consultar Google Calendar');
  }
}
