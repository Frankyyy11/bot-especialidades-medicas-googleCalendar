// Cliente mínimo de WhatsApp Cloud API (fetch nativo).
// Formato de los mensajes: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
// (verificar ahí si algo cambia; la versión de Graph API es configurable por WHATSAPP_API_VERSION).

import type { Outgoing } from '../engine/types.js';
import { logger } from '../util/logger.js';
import { fitOutgoing } from './limits.js';
import type { MessageSender } from './types.js';

/** WhatsApp limita los audios a 16 MB. */
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/** El token solo se envía a dominios de Meta: la URL del archivo viene en una respuesta y no se confía a ciegas. */
export function isMetaMediaUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && /(^|\.)(facebook\.com|fbsbx\.com|fbcdn\.net|whatsapp\.net|whatsapp\.com)$/.test(hostname);
  } catch {
    return false;
  }
}

export interface WhatsAppClientOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  fetchFn?: typeof fetch;
}

/** Cuerpo JSON para POST /{phone-number-id}/messages. Función pura (se prueba sin red). */
export function buildMessagePayload(to: string, outgoing: Outgoing): Record<string, unknown> {
  const message = fitOutgoing(outgoing);
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  switch (message.type) {
    case 'text':
      return { ...base, type: 'text', text: { preview_url: false, body: message.body } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: message.body },
          action: { buttons: message.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
        },
      };
    case 'list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: message.body },
          action: {
            button: message.buttonLabel,
            sections: [
              {
                ...(message.sectionTitle ? { title: message.sectionTitle } : {}),
                rows: message.rows.map((r) => ({
                  id: r.id,
                  title: r.title,
                  ...(r.description ? { description: r.description } : {}),
                })),
              },
            ],
          },
        },
      };
  }
}

export class WhatsAppClient implements MessageSender {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: WhatsAppClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private get url(): string {
    return `https://graph.facebook.com/${this.options.apiVersion}/${this.options.phoneNumberId}/messages`;
  }

  async send(to: string, message: Outgoing): Promise<void> {
    await this.post(buildMessagePayload(to, message), to);
  }

  /** Marca el mensaje entrante como leído (doble check azul). */
  async markRead(messageId: string): Promise<void> {
    await this.post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId });
  }

  /**
   * Descarga un archivo recibido con la Media API, en dos pasos: GET /{media-id} devuelve una URL temporal
   * y esa URL se baja con el mismo token. El contenido solo vive en memoria; nunca se escribe a disco.
   *
   * VERIFICAR CONTRA LA DOCUMENTACIÓN OFICIAL DE META (nunca se probó contra el servicio real):
   * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media — campos `url`, `mime_type`,
   * `file_size`, y que la URL exige el encabezado Authorization.
   */
  async downloadMedia(mediaId: string, signal?: AbortSignal): Promise<{ data: Buffer; mimeType: string }> {
    const headers = { Authorization: `Bearer ${this.options.accessToken}` };
    const init: RequestInit = { headers, ...(signal ? { signal } : {}) };
    const meta = await this.fetchFn(`https://graph.facebook.com/${this.options.apiVersion}/${encodeURIComponent(mediaId)}`, init);
    if (!meta.ok) throw new Error(`No se pudo consultar el archivo de WhatsApp (estado ${meta.status})`);
    const info = (await meta.json()) as { url?: unknown; mime_type?: unknown; file_size?: unknown };
    if (typeof info.url !== 'string' || !isMetaMediaUrl(info.url)) throw new Error('WhatsApp devolvió una URL de archivo no válida');
    if (typeof info.file_size === 'number' && info.file_size > MAX_MEDIA_BYTES) throw new Error('El archivo de WhatsApp excede el tamaño máximo');

    const file = await this.fetchFn(info.url, init);
    if (!file.ok) throw new Error(`No se pudo descargar el archivo de WhatsApp (estado ${file.status})`);
    const data = Buffer.from(await file.arrayBuffer());
    if (data.length === 0 || data.length > MAX_MEDIA_BYTES) throw new Error('El archivo de WhatsApp está vacío o excede el tamaño máximo');
    const mimeType = typeof info.mime_type === 'string' ? info.mime_type : (file.headers.get('content-type') ?? 'application/octet-stream');
    return { data, mimeType };
  }

  /** POST con un reintento simple ante error de red o 5xx/429. */
  private async post(payload: Record<string, unknown>, to?: string): Promise<void> {
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (response.ok) return;
        lastStatus = response.status;
        if (response.status < 500 && response.status !== 429) break;
      } catch {
        lastStatus = undefined;
      }
    }
    // Sin cuerpo del mensaje ni del error de Meta: podrían incluir datos del paciente.
    logger.error('whatsapp_send_failed', { to, status: lastStatus ?? 'red' });
    throw new Error(`No se pudo enviar el mensaje de WhatsApp (estado ${lastStatus ?? 'red'})`);
  }
}
