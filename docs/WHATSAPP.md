# WhatsApp Cloud API en modo coexistencia

> **IMPORTANTE: verifique todo contra la documentación oficial de Meta.** Los pasos, nombres de pantallas, requisitos y el formato de algunos eventos cambian con el tiempo. Esta guía describe el camino general y señala lo que el código asume. Empiece por <https://developers.facebook.com/docs/whatsapp/> (secciones de Cloud API, Embedded Signup y coexistencia / "Business App").

## Qué es la coexistencia

El centro puede **seguir usando la app WhatsApp Business en el celular con el mismo número**, mientras el bot responde por la Cloud API. Recepción puede escribir a mano cuando quiera. Cuando eso pasa, el bot debe callarse en esa conversación: por eso el código escucha los **ecos** de mensajes enviados desde la app y pausa al bot `HUMAN_PAUSE_MINUTES` (120 por defecto).

## Pasos generales

1. **Pasar a WhatsApp Business** si hoy usan la app normal de WhatsApp: instalar la app *WhatsApp Business* con el mismo número y migrar el chat. La coexistencia parte de un número que ya está en la app Business.
2. **Cuenta en Meta Business** (business.facebook.com) y verificación del negocio si Meta la pide.
3. **App en Meta for Developers** (tipo Negocio) con el producto **WhatsApp**.
4. **Vincular el número por coexistencia** mediante el flujo que Meta indica para ello (hoy, el de *Embedded Signup* para números de la app Business, donde se escanea un QR desde el celular). Verifique en la documentación vigente los requisitos: versión mínima de la app, antigüedad del número, países admitidos (confirme que Costa Rica esté incluida) y límites de funcionamiento mientras coexisten.
5. **Anotar** el *Phone Number ID* (`WHATSAPP_PHONE_NUMBER_ID`) y el *App Secret* (`WHATSAPP_APP_SECRET`, en Configuración de la app → Básica).
6. **Token permanente** (`WHATSAPP_ACCESS_TOKEN`): cree un *usuario del sistema* en Business Manager, asígnele la cuenta de WhatsApp y genere un token con permisos de mensajería. Los tokens temporales del panel caducan en horas y no sirven en producción.
7. **Webhook** (en la configuración de WhatsApp de la app):
   - URL de devolución: `https://SU-DOMINIO/webhook` (HTTPS obligatorio).
   - Token de verificación: el mismo valor de `WHATSAPP_VERIFY_TOKEN`. Meta hace un `GET` con `hub.challenge` y el servidor lo devuelve si el token coincide.
   - **Suscripciones**: `messages` y el campo de ecos de la app (`smb_message_echoes`). Revise en la documentación si, para coexistencia, conviene suscribir también otros campos (por ejemplo los de sincronización de historial o estado); el bot no los necesita.
8. **Probar**: escriba al número desde otro teléfono. Revise los logs del servidor (no incluyen el texto de los mensajes).

## Qué asume el código (puntos a verificar)

| Asunto | Dónde | Qué se asumió |
|---|---|---|
| Formato de los ecos | `parseEchoRecipients` en `src/whatsapp/parser.ts` | `changes[].field === "smb_message_echoes"` y `value.message_echoes[]` con `to` = teléfono del paciente. **Si Meta usa otra forma, ajustar solo esa función.** |
| Versión de Graph API | `WHATSAPP_API_VERSION` (por defecto `v23.0`) | Es un valor de partida; confirmar la vigente y su fecha de caducidad. |
| Mensajes interactivos | `buildMessagePayload` en `src/whatsapp/client.ts` | Botones `reply` (máx. 3), lista con `sections[].rows[]` (máx. 10 filas en total). Límites en `src/whatsapp/limits.ts`. |
| Marcar leído | `WhatsAppClient.markRead` | `POST /messages` con `status: "read"` y `message_id`. |
| Firma | `src/whatsapp/webhook.ts` | `X-Hub-Signature-256 = sha256=HMAC_SHA256(cuerpo crudo, App Secret)`. |

## Reglas de la plataforma que el bot respeta

- Solo responde a mensajes entrantes, dentro de la ventana de 24 horas. No envía plantillas ni inicia conversaciones.
- Mensajes de audio, imagen, documento o ubicación se contestan pidiendo usar texto.
- El webhook responde `200` de inmediato y procesa después; Meta reintenta si no recibe 200, por eso se deduplica por id de mensaje.

## Seguridad

Nunca suba el token, el App Secret ni el token de verificación al repositorio. Si alguno se filtra, regénerelo en Meta y actualice las variables del servidor.
