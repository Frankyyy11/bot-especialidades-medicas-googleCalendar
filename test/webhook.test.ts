import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Outgoing } from '../src/engine/types.js';
import type { MessageSender } from '../src/whatsapp/types.js';
import { createHarness } from './helpers.js';

const SECRET = 'secreto-de-prueba';
const VERIFY = 'token-de-prueba';
const PATIENT = '50688881234';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(options: { appSecret?: string | undefined } = { appSecret: SECRET }) {
  const harness = createHarness();
  const sent: Array<{ to: string; message: Outgoing }> = [];
  const sender: MessageSender = {
    send: async (to, message) => void sent.push({ to, message }),
    markRead: async () => undefined,
  };
  const app = createApp({ bot: harness.bot, sender, verifyToken: VERIFY, appSecret: options.appSecret });
  server = app.listen(0);
  await new Promise((r) => server!.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const post = (payload: unknown, headers: Record<string, string> | 'signed' = 'signed') => {
    const raw = JSON.stringify(payload);
    return fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers === 'signed' ? { 'x-hub-signature-256': sign(raw) } : headers) },
      body: raw,
    });
  };
  return { base, sent, post, harness, sign };
}

const textPayload = (id: string, text: string, from = PATIENT) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'W', changes: [{ field: 'messages', value: { messages: [{ from, id, type: 'text', text: { body: text } }] } }] }],
});
const echoPayload = (to: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'W', changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ from: '50622220000', to, id: 'echo-1', type: 'text' }] } }] }],
});

describe('GET /webhook (verificación)', () => {
  it('devuelve el challenge con el token correcto', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });

  it('rechaza con 403 un token incorrecto o un modo distinto', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`)).status).toBe(403);
    expect((await fetch(`${base}/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(403);
    expect((await fetch(`${base}/webhook`)).status).toBe(403);
  });
});

describe('POST /webhook (firma)', () => {
  it('firma válida: 200 y el bot responde', async () => {
    const { post, sent } = await start();
    expect((await post(textPayload('wamid.1', 'hola'))).status).toBe(200);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]!.to).toBe(PATIENT);
  });

  it('firma inválida o ausente: 401 y no se procesa nada', async () => {
    const { post, sent } = await start();
    expect((await post(textPayload('wamid.2', 'hola'), { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    expect((await post(textPayload('wamid.3', 'hola'), {})).status).toBe(401);
    expect((await post(textPayload('wamid.4', 'hola'), { 'x-hub-signature-256': 'basura' })).status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
  });

  it('la firma debe corresponder al cuerpo exacto (si se altera, 401)', async () => {
    const { base, sign } = await start();
    const original = JSON.stringify(textPayload('wamid.5', 'hola'));
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(original) },
      body: original.replace('hola', 'chao'),
    });
    expect(res.status).toBe(401);
  });

  it('sin WHATSAPP_APP_SECRET configurado el webhook queda deshabilitado (503)', async () => {
    const { post } = await start({ appSecret: undefined });
    expect((await post(textPayload('wamid.6', 'hola'), {})).status).toBe(503);
  });
});

describe('deduplicación', () => {
  it('el mismo id de mensaje solo se procesa una vez', async () => {
    const { post, sent } = await start();
    await post(textPayload('wamid.dup', 'hola'));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const afterFirst = sent.length;
    await post(textPayload('wamid.dup', 'hola'));
    await post(textPayload('wamid.dup', 'hola'));
    await new Promise((r) => setTimeout(r, 80));
    expect(sent.length).toBe(afterFirst);

    await post(textPayload('wamid.otro', 'menú'));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(afterFirst));
  });
});

describe('coexistencia: pausa por respuesta de recepción', () => {
  it('tras un eco, el bot no responde a ese paciente (pero sí a otros)', async () => {
    const { post, sent, harness } = await start();

    await post(echoPayload(PATIENT));
    await vi.waitFor(async () => expect(await harness.pauses.isPaused(PATIENT)).toBe(true));

    await post(textPayload('wamid.p1', 'hola'));
    await post(textPayload('wamid.o1', 'hola', '50677776666'));
    await vi.waitFor(() => expect(sent.some((s) => s.to === '50677776666')).toBe(true));
    expect(sent.some((s) => s.to === PATIENT)).toBe(false);
  });

  it('la pausa termina tras HUMAN_PAUSE_MINUTES', async () => {
    const { post, sent, harness } = await start();
    await post(echoPayload(PATIENT));
    await vi.waitFor(async () => expect(await harness.pauses.isPaused(PATIENT)).toBe(true));

    harness.advanceMinutes(121);
    await post(textPayload('wamid.p2', 'hola'));
    await vi.waitFor(() => expect(sent.some((s) => s.to === PATIENT)).toBe(true));
  });
});

describe('otros', () => {
  it('statuses de entrega se aceptan con 200 sin responder nada', async () => {
    const { post, sent } = await start();
    const statuses = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'read' }] } }] }] };
    expect((await post(statuses)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
  });

  it('/health responde', async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true });
  });
});
