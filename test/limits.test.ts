import { describe, expect, it } from 'vitest';
import { buildMessagePayload } from '../src/whatsapp/client.js';
import { fitOutgoing, LIMITS, truncate } from '../src/whatsapp/limits.js';
import type { Outgoing } from '../src/engine/types.js';

const long = (n: number) => 'x'.repeat(n);

describe('límites de WhatsApp', () => {
  it('truncate respeta el máximo y agrega puntos suspensivos', () => {
    expect(truncate('hola', 10)).toBe('hola');
    const t = truncate(long(30), 24);
    expect([...t]).toHaveLength(24);
    expect(t.endsWith('…')).toBe(true);
  });

  it('no parte emojis ni caracteres fuera del plano básico', () => {
    const t = truncate('😀'.repeat(30), 24);
    expect([...t]).toHaveLength(24);
    expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // sin sustitutos huérfanos
  });

  it('botones: máximo 3 y título <= 20', () => {
    const msg: Outgoing = {
      type: 'buttons',
      body: 'x',
      buttons: Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, title: long(40) })),
    };
    const fitted = fitOutgoing(msg);
    if (fitted.type !== 'buttons') throw new Error('debía seguir siendo botones');
    expect(fitted.buttons).toHaveLength(LIMITS.maxButtons);
    for (const b of fitted.buttons) expect([...b.title].length).toBeLessThanOrEqual(20);
  });

  it('lista: máximo 10 filas, título <= 24, descripción <= 72, etiqueta <= 20', () => {
    const msg: Outgoing = {
      type: 'list',
      body: 'x',
      buttonLabel: long(40),
      sectionTitle: long(40),
      rows: Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, title: long(60), description: long(200) })),
    };
    const fitted = fitOutgoing(msg);
    if (fitted.type !== 'list') throw new Error('debía seguir siendo lista');
    expect(fitted.rows).toHaveLength(10);
    expect([...fitted.buttonLabel].length).toBeLessThanOrEqual(20);
    expect([...(fitted.sectionTitle ?? '')].length).toBeLessThanOrEqual(24);
    for (const r of fitted.rows) {
      expect([...r.title].length).toBeLessThanOrEqual(24);
      expect([...(r.description ?? '')].length).toBeLessThanOrEqual(72);
    }
  });

  it('cuerpo interactivo <= 1024 y texto <= 4096', () => {
    const buttons = fitOutgoing({ type: 'buttons', body: long(3000), buttons: [{ id: 'a', title: 'A' }] });
    expect([...buttons.body].length).toBeLessThanOrEqual(1024);
    const text = fitOutgoing({ type: 'text', body: long(9000) });
    expect([...text.body].length).toBeLessThanOrEqual(4096);
  });

  it('degrada a texto si no quedan botones o filas (WhatsApp rechaza listas vacías)', () => {
    expect(fitOutgoing({ type: 'buttons', body: 'hola', buttons: [] }).type).toBe('text');
    expect(fitOutgoing({ type: 'list', body: 'hola', buttonLabel: 'Ver', rows: [] }).type).toBe('text');
  });

  it('un mensaje que ya cumple no se modifica', () => {
    const msg: Outgoing = { type: 'buttons', body: 'ok', buttons: [{ id: 'a', title: 'Confirmar' }] };
    expect(fitOutgoing(msg)).toEqual(msg);
  });

  it('el payload de envío ya sale recortado', () => {
    const payload = buildMessagePayload('50600001111', {
      type: 'list',
      body: 'x',
      buttonLabel: 'Ver',
      rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: long(50) })),
    });
    const rows = (payload as any).interactive.action.sections[0].rows as Array<{ title: string }>;
    expect(rows).toHaveLength(10);
    expect([...rows[0]!.title].length).toBeLessThanOrEqual(24);
  });

  it('el payload de botones y de texto tiene la forma de la Cloud API', () => {
    expect(buildMessagePayload('506', { type: 'text', body: 'hola' })).toMatchObject({
      messaging_product: 'whatsapp',
      to: '506',
      type: 'text',
      text: { body: 'hola' },
    });
    expect(buildMessagePayload('506', { type: 'buttons', body: 'b', buttons: [{ id: 'i', title: 'T' }] })).toMatchObject({
      type: 'interactive',
      interactive: { type: 'button', action: { buttons: [{ type: 'reply', reply: { id: 'i', title: 'T' } }] } },
    });
  });
});
