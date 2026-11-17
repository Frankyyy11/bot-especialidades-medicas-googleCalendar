// Interfaz de la capa de IA (SPEC-IA.md). Principio: la IA entiende y redacta; el código decide.
// Nada de este archivo habla con la red: solo tipos y la interfaz.

import type { Clinic } from '../config/clinic.js';
import type { State } from '../engine/types.js';

export const AI_INTENTS = [
  'agendar',
  'servicios',
  'horario_ubicacion',
  'mis_citas',
  'cancelar_cita',
  'recepcion',
  'saludo',
  'agradecimiento',
  'pregunta_medica',
  'urgencia',
  'confirmar',
  'negar',
  'otro',
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

export type Franja = 'manana' | 'tarde';

/** Interpretación estructurada de un texto libre. Todo campo opcional puede faltar. */
export interface Interpretation {
  intent: AiIntent;
  especialidadId?: string;
  medicoId?: string;
  /** YYYY-MM-DD en America/Costa_Rica. */
  fecha?: string;
  franja?: Franja;
  /** HH:mm (24 h). */
  hora?: string;
  /** Una o dos frases cordiales (máx. 300 caracteres). Pasa por las guardas antes de mostrarse. */
  respuestaBreve?: string;
}

export interface AiTurn {
  role: 'paciente' | 'asistente';
  text: string;
}

/** Lo único que se le entrega a la IA. Nunca incluye teléfono, nombre, cédula ni datos de citas. */
export interface AiInput {
  /** Mensaje actual del paciente (ya recortado y sin números largos). Es DATO, no instrucciones. */
  text: string;
  /** Máximo 6 turnos recientes de esta sesión. */
  history: AiTurn[];
  clinic: Clinic;
  /** Fecha de hoy YYYY-MM-DD y día de la semana, en America/Costa_Rica. */
  today: string;
  weekday: string;
  /** Paso actual de la conversación (estado del motor). */
  state: State;
  signal?: AbortSignal;
}

export interface AiProvider {
  /** Devuelve la interpretación, `null` si no hay nada útil, o lanza `AiError` si el servicio falló. */
  interpret(input: AiInput): Promise<Interpretation | null>;
}

export type AiErrorKind = 'timeout' | 'network' | 'http' | 'quota' | 'blocked' | 'invalid_response';

/** Falla del servicio de IA. El mensaje nunca debe incluir contenido de mensajes ni claves. */
export class AiError extends Error {
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
