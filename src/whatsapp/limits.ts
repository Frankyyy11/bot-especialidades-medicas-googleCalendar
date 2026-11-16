// Límites del mensaje interactivo de WhatsApp. Se aplican justo antes de enviar,
// como red de seguridad: el motor ya genera mensajes dentro de los límites,
// pero un nombre de médico largo en la config no debe romper el envío.

import type { ButtonOption, ListRow, Outgoing } from '../engine/types.js';

export const LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  maxButtons: 3,
  buttonTitle: 20,
  buttonLabel: 20, // texto del botón que abre la lista
  maxRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  id: 200,
} as const;

export function truncate(value: string, max: number): string {
  const chars = [...value]; // cuenta caracteres Unicode, no unidades UTF-16
  return chars.length <= max ? value : chars.slice(0, max - 1).join('').trimEnd() + '…';
}

function fitButton(b: ButtonOption): ButtonOption {
  return { id: b.id.slice(0, LIMITS.id), title: truncate(b.title, LIMITS.buttonTitle) };
}

function fitRow(r: ListRow): ListRow {
  return {
    id: r.id.slice(0, LIMITS.id),
    title: truncate(r.title, LIMITS.rowTitle),
    ...(r.description ? { description: truncate(r.description, LIMITS.rowDescription) } : {}),
  };
}

/** Devuelve un mensaje que cumple los límites de WhatsApp (recorta; nunca lanza). */
export function fitOutgoing(message: Outgoing): Outgoing {
  switch (message.type) {
    case 'text':
      return { type: 'text', body: truncate(message.body, LIMITS.textBody) };
    case 'buttons': {
      const body = truncate(message.body, LIMITS.interactiveBody);
      const buttons = message.buttons.slice(0, LIMITS.maxButtons).map(fitButton);
      return buttons.length > 0 ? { type: 'buttons', body, buttons } : { type: 'text', body };
    }
    case 'list': {
      const body = truncate(message.body, LIMITS.interactiveBody);
      const rows = message.rows.slice(0, LIMITS.maxRows).map(fitRow);
      if (rows.length === 0) return { type: 'text', body };
      return {
        type: 'list',
        body,
        buttonLabel: truncate(message.buttonLabel, LIMITS.buttonLabel),
        rows,
        ...(message.sectionTitle ? { sectionTitle: truncate(message.sectionTitle, LIMITS.sectionTitle) } : {}),
      };
    }
  }
}
