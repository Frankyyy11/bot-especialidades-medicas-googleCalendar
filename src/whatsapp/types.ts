import type { Incoming, Outgoing } from '../engine/types.js';

/** Mensaje entrante normalizado a partir del webhook de Meta. */
export interface ParsedMessage {
  /** Id del mensaje en WhatsApp (wamid...), usado para deduplicar y marcar como leído. */
  id: string;
  /** Teléfono del paciente, solo dígitos con código de país (p. ej. 50688881234). */
  from: string;
  message: Incoming;
}

export interface ParsedWebhook {
  messages: ParsedMessage[];
  /** Teléfonos de pacientes a quienes recepción respondió desde la app (ecos de coexistencia). */
  echoedTo: string[];
}

/** Lo que el resto del sistema necesita para hablar con WhatsApp (el cliente real o uno simulado). */
export interface MessageSender {
  send(to: string, message: Outgoing): Promise<void>;
  markRead(messageId: string): Promise<void>;
}
