import { expect } from 'vitest';
import { MemoryAgendaProvider } from '../src/agenda/memory.js';
import type { AiProvider } from '../src/ai/provider.js';
import type { AudioClip, Transcriber } from '../src/ai/transcribe.js';
import { Bot } from '../src/bot.js';
import { loadClinic, parseClinic, type Clinic } from '../src/config/clinic.js';
import type { Incoming, Outgoing } from '../src/engine/types.js';
import { MemoryHumanPauseStore, MemorySessionStore } from '../src/sessions/store.js';
import { fitOutgoing } from '../src/whatsapp/limits.js';

export const PHONE = '50600001111';

/** Lunes 16-nov-2026, 10:00 hora de Costa Rica. */
export const MONDAY_10AM = new Date('2026-11-16T10:00:00-06:00');

export function baseClinicJson(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(loadClinic('config/centro.json')));
}

export function clinicWith(patch: Record<string, unknown>): Clinic {
  return parseClinic({ ...baseClinicJson(), ...patch });
}

export interface HarnessOptions {
  clinic?: Clinic;
  now?: Date;
  confirmationMode?: 'recepcion' | 'auto';
  sessionTtlMinutes?: number;
  /** Capa de IA simulada (sin red). Sin esto el bot funciona solo con reglas. */
  ai?: AiProvider;
  aiLocal?: AiProvider;
  /** Transcriptor simulado de notas de voz. Sin esto los audios se contestan pidiendo texto. */
  transcriber?: Transcriber;
  audioMaxSeconds?: number;
  audioTimeoutMs?: number;
  aiTimeoutMs?: number;
  aiMaxCallsPerDay?: number;
}

/** Bot completo con agenda en memoria y reloj controlable. */
export function createHarness(options: HarnessOptions = {}) {
  const clinic = options.clinic ?? loadClinic('config/centro.json');
  const clock = { now: (options.now ?? MONDAY_10AM).getTime() };
  const now = () => new Date(clock.now);
  const agenda = new MemoryAgendaProvider({ clinic, now, confirmationMode: options.confirmationMode ?? 'recepcion' });
  const sessions = new MemorySessionStore((options.sessionTtlMinutes ?? 30) * 60_000, () => clock.now);
  const pauses = new MemoryHumanPauseStore(() => clock.now);
  const bot = new Bot({
    clinic,
    agenda,
    sessions,
    pauses,
    humanPauseMinutes: 120,
    now,
    ...(options.ai
      ? {
          ai: {
            provider: options.ai,
            ...(options.aiLocal ? { local: options.aiLocal } : {}),
            ...(options.aiTimeoutMs ? { timeoutMs: options.aiTimeoutMs } : {}),
            ...(options.aiMaxCallsPerDay !== undefined ? { maxCallsPerPhonePerDay: options.aiMaxCallsPerDay } : {}),
          },
        }
      : {}),
    ...(options.transcriber
      ? {
          audio: {
            transcriber: options.transcriber,
            ...(options.audioMaxSeconds !== undefined ? { maxSeconds: options.audioMaxSeconds } : {}),
            ...(options.audioTimeoutMs !== undefined ? { timeoutMs: options.audioTimeoutMs } : {}),
            ...(options.aiMaxCallsPerDay !== undefined ? { maxCallsPerPhonePerDay: options.aiMaxCallsPerDay } : {}),
          },
        }
      : {}),
  });

  async function send(incoming: Incoming, phone = PHONE): Promise<Outgoing[]> {
    const replies = await bot.handle(phone, incoming);
    for (const reply of replies) {
      // Todo lo que el motor genera debe caber en WhatsApp sin recortes.
      expect(fitOutgoing(reply), 'el mensaje excede los límites de WhatsApp').toEqual(reply);
      expect(textOf(reply)).not.toMatch(/motivo de (la )?consulta/i); // nunca se pregunta el motivo
    }
    return replies;
  }

  return {
    clinic,
    agenda,
    bot,
    sessions,
    pauses,
    clock,
    advanceMinutes: (m: number) => {
      clock.now += m * 60_000;
    },
    say: (text: string, phone?: string) => send({ type: 'text', text }, phone),
    pick: (id: string, phone?: string) => send({ type: 'choice', id, title: id }, phone),
    send,
    /** Envía una nota de voz. Devuelve las respuestas y los acuses inmediatos, en el orden en que salieron. */
    voice: async (clip: AudioClip | (() => Promise<AudioClip>) = wavClip(5), phone = PHONE) => {
      const acks: Outgoing[] = [];
      const replies = await bot.handleAudio(phone, { load: typeof clip === 'function' ? clip : async () => clip }, { ack: (m) => void acks.push(m) });
      for (const reply of [...acks, ...replies]) expect(fitOutgoing(reply), 'el mensaje excede los límites de WhatsApp').toEqual(reply);
      return { replies, acks };
    },
  };
}

export function textOf(message: Outgoing): string {
  if (message.type === 'text') return message.body;
  if (message.type === 'buttons') return `${message.body}\n${message.buttons.map((b) => b.title).join(' | ')}`;
  return `${message.body}\n${message.rows.map((r) => `${r.title} ${r.description ?? ''}`).join(' | ')}`;
}

export const allText = (replies: Outgoing[]): string => replies.map(textOf).join('\n---\n');

export function lastList(replies: Outgoing[]) {
  const list = [...replies].reverse().find((r) => r.type === 'list');
  if (!list || list.type !== 'list') throw new Error(`No hay lista en: ${allText(replies)}`);
  return list;
}

export function lastButtons(replies: Outgoing[]) {
  const b = [...replies].reverse().find((r) => r.type === 'buttons');
  if (!b || b.type !== 'buttons') throw new Error(`No hay botones en: ${allText(replies)}`);
  return b;
}

type Harness = ReturnType<typeof createHarness>;

/** Agenda hasta la confirmación: devuelve el resumen y el id de día/hora elegidos. */
export async function bookUntilSummary(h: Harness, spec = 'dermatologia', name = 'Maria Prueba Rojas') {
  await h.say('hola');
  await h.pick('menu:agendar');
  let replies = await h.pick(`esp:${spec}`);
  if (lastList(replies).rows.some((r) => r.id === 'med:any')) replies = await h.pick('med:any');
  const day = lastList(replies).rows[0]!;
  replies = await h.pick(day.id);
  const hour = lastList(replies).rows[0]!;
  await h.pick(hour.id);
  replies = await h.say(name);
  return { replies, dayId: day.id, hourId: hour.id, date: day.id.slice(4), time: hour.id.slice(5) };
}

/** WAV PCM válido (silencio) de la duración pedida: 8 kHz, 8 bits, mono = 8000 bytes por segundo. */
export function wavClip(seconds: number): AudioClip {
  const size = Math.round(seconds * 8000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + size, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(size, 40);
  return { data: Buffer.concat([header, Buffer.alloc(size, 128)]), mimeType: 'audio/wav' };
}

/** Página OGG mínima con cabecera Opus cuya última posición equivale a la duración pedida (48 kHz). */
export function oggOpusClip(seconds: number): AudioClip {
  const page = (granule: bigint, payload: Buffer) => {
    const head = Buffer.alloc(27);
    head.write('OggS', 0);
    head.writeBigUInt64LE(granule, 6);
    return Buffer.concat([head, payload]);
  };
  return { data: Buffer.concat([page(0n, Buffer.from('OpusHead')), page(BigInt(Math.round(seconds * 48000)), Buffer.alloc(64))]), mimeType: 'audio/ogg; codecs=opus' };
}
