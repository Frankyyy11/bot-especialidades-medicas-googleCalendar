import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type Router } from 'express';
import { logger } from '../util/logger.js';
import { TtlSet } from '../util/ttlCache.js';
import { parseWebhook } from './parser.js';
import type { ParsedMessage } from './types.js';

export interface WebhookOptions {
  verifyToken: string | undefined;
  appSecret: string | undefined;
  onMessage: (message: ParsedMessage) => Promise<void>;
  /** Recepción escribió a mano a este teléfono (eco de coexistencia). */
  onEcho: (phone: string) => void | Promise<void>;
  /** Para pruebas: reloj de la deduplicación. */
  now?: () => number;
}

/** Firma esperada: "sha256=" + HMAC-SHA256(cuerpo crudo, app secret). Comparación en tiempo constante. */
export function isValidSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createWebhookRouter(options: WebhookOptions): Router {
  const router = express.Router();
  // Meta reintenta entregas: se recuerdan los ids 24 h para no responder dos veces.
  const seen = new TtlSet(24 * 3_600_000, options.now);

  // Verificación inicial del webhook (configuración en el panel de Meta).
  router.get('/', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as Record<string, string | undefined>;
    if (options.verifyToken && mode === 'subscribe' && token === options.verifyToken && challenge) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  // La firma se calcula sobre el cuerpo crudo: por eso express.raw y no express.json.
  router.post('/', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    if (!options.appSecret) {
      res.sendStatus(503); // sin secreto no se puede validar: webhook deshabilitado
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidSignature(raw, req.header('x-hub-signature-256'), options.appSecret)) {
      logger.warn('webhook_firma_invalida');
      res.sendStatus(401);
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      res.sendStatus(400);
      return;
    }

    // Responder 200 de inmediato; el procesamiento ocurre después.
    res.sendStatus(200);
    void processPayload(body, options, seen);
  });

  return router;
}

async function processPayload(body: unknown, options: WebhookOptions, seen: TtlSet): Promise<void> {
  try {
    const { messages, echoedTo } = parseWebhook(body);
    for (const phone of echoedTo) await options.onEcho(phone);
    for (const message of messages) {
      if (seen.seen(message.id)) {
        logger.debug('webhook_duplicado', { id: message.id });
        continue;
      }
      try {
        await options.onMessage(message);
      } catch (error) {
        logger.error('mensaje_fallido', { from: message.from, error });
      }
    }
  } catch (error) {
    logger.error('webhook_error', { error });
  }
}
