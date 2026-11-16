// Normaliza el cuerpo del webhook de WhatsApp Cloud API.
// Se escribe de forma defensiva (nada de suposiciones sobre campos opcionales)
// porque el payload lo controla Meta y puede traer eventos que no usamos.

import type { Incoming } from '../engine/types.js';
import type { ParsedMessage, ParsedWebhook } from './types.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const digits = (v: string): string => v.replace(/\D/g, '');

/** Tipos de mensaje que se ignoran por completo (no se responde). */
const IGNORED_TYPES = new Set(['reaction', 'system', 'request_welcome', 'ephemeral']);

/** Convierte un mensaje individual de `value.messages[]` en un Incoming (o null si se ignora). */
function parseIncoming(raw: Rec): Incoming | null {
  const type = str(raw.type) ?? 'unknown';
  if (IGNORED_TYPES.has(type)) return null;

  if (type === 'text') {
    const body = isRec(raw.text) ? str(raw.text.body) : undefined;
    return body ? { type: 'text', text: body } : { type: 'unsupported', kind: 'text-vacio' };
  }

  if (type === 'interactive' && isRec(raw.interactive)) {
    const reply = isRec(raw.interactive.button_reply)
      ? raw.interactive.button_reply
      : isRec(raw.interactive.list_reply)
        ? raw.interactive.list_reply
        : undefined;
    const id = reply ? str(reply.id) : undefined;
    if (reply && id) return { type: 'choice', id, title: str(reply.title) ?? '' };
    return { type: 'unsupported', kind: 'interactive' };
  }

  // Respuesta rápida de plantilla: se trata como texto.
  if (type === 'button' && isRec(raw.button)) {
    const text = str(raw.button.text);
    if (text) return { type: 'text', text };
  }

  return { type: 'unsupported', kind: type };
}

/**
 * Extrae mensajes entrantes del payload. Ignora `statuses` (acuses de entrega/lectura)
 * y cualquier campo distinto de "messages".
 */
export function parseIncomingMessages(body: unknown): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  if (!isRec(body)) return out;
  for (const entry of asArray(body.entry)) {
    if (!isRec(entry)) continue;
    for (const change of asArray(entry.changes)) {
      if (!isRec(change) || change.field !== 'messages' || !isRec(change.value)) continue;
      for (const raw of asArray(change.value.messages)) {
        if (!isRec(raw)) continue;
        const id = str(raw.id);
        const from = str(raw.from);
        if (!id || !from) continue;
        const message = parseIncoming(raw);
        if (message) out.push({ id, from: digits(from), message });
      }
    }
  }
  return out;
}

/**
 * Coexistencia: eco de un mensaje que recepción envió desde la app WhatsApp Business.
 * Devuelve los teléfonos de los pacientes destinatarios.
 *
 * VERIFICAR CONTRA LA DOCUMENTACIÓN OFICIAL DE META: esta función asume que el evento llega como
 * change.field === "smb_message_echoes" con value.message_echoes[] y, en cada elemento,
 * `to` = teléfono del paciente (y `from` = número del negocio). Si el formato real difiere
 * (nombres de campos, o ecos dentro de otro campo), ajustar SOLO esta función.
 */
export function parseEchoRecipients(body: unknown): string[] {
  const recipients: string[] = [];
  if (!isRec(body)) return recipients;
  for (const entry of asArray(body.entry)) {
    if (!isRec(entry)) continue;
    for (const change of asArray(entry.changes)) {
      if (!isRec(change) || change.field !== 'smb_message_echoes' || !isRec(change.value)) continue;
      for (const echo of asArray(change.value.message_echoes)) {
        const to = isRec(echo) ? str(echo.to) : undefined;
        if (to) recipients.push(digits(to));
      }
    }
  }
  return recipients;
}

export function parseWebhook(body: unknown): ParsedWebhook {
  return { messages: parseIncomingMessages(body), echoedTo: parseEchoRecipients(body) };
}
