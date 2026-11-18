import type { Clinic } from '../../config/clinic.js';
import type { AgendaProvider } from '../../agenda/provider.js';
import type { ConfirmationMode } from '../../agenda/provider.js';
import { normalize } from '../intents.js';
import { newBooking, type Incoming, type Outgoing, type Session } from '../types.js';
import { M } from '../messages.js';

export interface EngineContext {
  clinic: Clinic;
  agenda: AgendaProvider;
  now: () => Date;
  confirmationMode?: ConfirmationMode;
  /** true si hay una capa de IA activa (solo cambia el aviso de privacidad del primer contacto). */
  aiEnabled?: boolean;
  /** true si la transcripción de notas de voz está activa (aviso de privacidad y texto de "no soportado"). */
  audioEnabled?: boolean;
}

/** Respuesta de un manejador de estado: mensajes, o `null` si no entendió, o un reintento con texto propio. */
export type StepResult = Outgoing[] | { retry: Outgoing[] } | null;

export interface Option {
  id: string;
  /** Textos con los que el paciente podría escribir esta opción. */
  keys: string[];
}

/** Resuelve la opción elegida: por toque (id exacto) o, si escribió, por coincidencia única de texto. */
export function pickOption(incoming: Incoming, options: readonly Option[]): string | null {
  if (incoming.type === 'choice') return options.some((o) => o.id === incoming.id) ? incoming.id : null;
  if (incoming.type !== 'text') return null;
  const norm = normalize(incoming.text);
  if (!norm) return null;
  const hits = options.filter((o) =>
    o.keys.map(normalize).filter(Boolean).some((key) => norm === key || ` ${norm} `.includes(` ${key} `)),
  );
  return hits.length === 1 ? (hits[0] as Option).id : null;
}

export function resetFlow(s: Session): void {
  s.booking = newBooking();
  delete s.cancelAppointmentId;
  s.state = 'MENU';
}

/** Menú principal (reinicia cualquier flujo en curso). */
export function showMenu(s: Session): Outgoing[] {
  resetFlow(s);
  return [M.menu()];
}

export function abandonFlow(s: Session): Outgoing[] {
  resetFlow(s);
  return [M.abandon(), M.menu()];
}
