import type { Clinic } from '../config/clinic.js';
import type { Env } from '../env.js';
import { createServiceAccountTokenProvider, GoogleCalendarProvider } from './googleCalendar.js';
import { MemoryAgendaProvider } from './memory.js';
import type { AgendaProvider } from './provider.js';
import { SikuAgendaProvider } from './siku.js';

export function createAgendaProvider(env: Env, clinic: Clinic): AgendaProvider {
  switch (env.AGENDA_PROVIDER) {
    case 'memory':
      return new MemoryAgendaProvider({ clinic, confirmationMode: env.CONFIRMATION_MODE });
    case 'siku':
      return new SikuAgendaProvider();
    case 'google': {
      const missing = clinic.especialidades.flatMap((e) => e.medicos).filter((m) => !m.calendarId);
      if (missing.length > 0) {
        throw new Error(`Faltan calendarId en config/centro.json para: ${missing.map((m) => m.id).join(', ')}`);
      }
      return new GoogleCalendarProvider({
        clinic,
        confirmationMode: env.CONFIRMATION_MODE,
        getAccessToken: createServiceAccountTokenProvider({
          ...(env.GOOGLE_SERVICE_ACCOUNT_FILE ? { file: env.GOOGLE_SERVICE_ACCOUNT_FILE } : {}),
          ...(env.GOOGLE_SERVICE_ACCOUNT_JSON ? { json: env.GOOGLE_SERVICE_ACCOUNT_JSON } : {}),
        }),
      });
    }
  }
}
