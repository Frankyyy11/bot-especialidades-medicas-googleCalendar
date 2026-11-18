import express, { type Express } from 'express';
import type { Bot } from './bot.js';
import { logger } from './util/logger.js';
import { createWebhookRouter } from './whatsapp/webhook.js';
import type { MessageSender } from './whatsapp/types.js';

export interface AppOptions {
  bot: Bot;
  sender: MessageSender;
  verifyToken: string | undefined;
  appSecret: string | undefined;
}

/** Aplicación Express: /health y /webhook. Separada de index.ts para poder probarla. */
export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true, whatsapp: Boolean(options.verifyToken && options.appSecret) });
  });

  app.use(
    '/webhook',
    createWebhookRouter({
      verifyToken: options.verifyToken,
      appSecret: options.appSecret,
      onEcho: (phone) => options.bot.onHumanReply(phone),
      onMessage: async ({ id, from, message, audio }) => {
        // Marcar como leído es opcional: si falla, no debe impedir la respuesta.
        options.sender.markRead(id).catch(() => undefined);
        const download = options.sender.downloadMedia?.bind(options.sender);
        const replies =
          audio && download && options.bot.audioEnabled
            ? await options.bot.handleAudio(
                from,
                {
                  load: async (signal) => {
                    const file = await download(audio.mediaId, signal);
                    return { data: file.data, mimeType: audio.mimeType ?? file.mimeType };
                  },
                },
                // Acuse inmediato: sale antes de descargar y transcribir.
                { ack: (ackMessage) => options.sender.send(from, ackMessage) },
              )
            : await options.bot.handle(from, message);
        for (const reply of replies) {
          try {
            await options.sender.send(from, reply);
          } catch (error) {
            logger.error('envio_fallido', { to: from, error });
            break; // si falla uno, no tiene sentido seguir con los demás
          }
        }
      },
    }),
  );

  return app;
}
