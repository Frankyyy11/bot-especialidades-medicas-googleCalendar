import { describe, expect, it } from 'vitest';
import { parseEchoRecipients, parseIncomingMessages, parseWebhook } from '../src/whatsapp/parser.js';

const wrap = (value: Record<string, unknown>, field = 'messages') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field, value }] }],
});

describe('parser del webhook', () => {
  it('texto', () => {
    const body = wrap({ messages: [{ from: '50688881234', id: 'wamid.1', type: 'text', text: { body: 'Hola' } }] });
    expect(parseIncomingMessages(body)).toEqual([
      { id: 'wamid.1', from: '50688881234', message: { type: 'text', text: 'Hola' } },
    ]);
  });

  it('respuesta de botón y de lista', () => {
    const body = wrap({
      messages: [
        { from: '506', id: 'a', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'conf:si', title: 'Confirmar' } } },
        { from: '506', id: 'b', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'esp:cardiologia', title: 'Cardiología' } } },
      ],
    });
    expect(parseIncomingMessages(body).map((m) => m.message)).toEqual([
      { type: 'choice', id: 'conf:si', title: 'Confirmar' },
      { type: 'choice', id: 'esp:cardiologia', title: 'Cardiología' },
    ]);
  });

  it.each(['audio', 'image', 'document', 'location', 'video', 'sticker'])('%s -> no soportado', (type) => {
    const body = wrap({ messages: [{ from: '506', id: 'x', type }] });
    expect(parseIncomingMessages(body)[0]!.message).toEqual({ type: 'unsupported', kind: type });
  });

  it('ignora statuses (acuses) y reacciones', () => {
    const statuses = wrap({ statuses: [{ id: 'wamid.1', status: 'delivered', recipient_id: '506' }] });
    expect(parseIncomingMessages(statuses)).toEqual([]);
    const reaction = wrap({ messages: [{ from: '506', id: 'r', type: 'reaction', reaction: { emoji: 'x' } }] });
    expect(parseIncomingMessages(reaction)).toEqual([]);
  });

  it('tolera basura sin lanzar', () => {
    for (const junk of [null, undefined, 42, 'x', [], {}, { entry: 'no' }, { entry: [null, { changes: 5 }] }]) {
      expect(parseWebhook(junk)).toEqual({ messages: [], echoedTo: [] });
    }
  });

  it('ecos de coexistencia: devuelve el teléfono del paciente', () => {
    const body = wrap({ message_echoes: [{ from: '50622220000', to: '+506 8888-1234', id: 'e1', type: 'text' }] }, 'smb_message_echoes');
    expect(parseEchoRecipients(body)).toEqual(['50688881234']);
    expect(parseIncomingMessages(body)).toEqual([]); // un eco nunca se trata como mensaje del paciente
  });
});
