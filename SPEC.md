# SPEC — Bot de WhatsApp para centro médico de especialidades

Especificación de arquitectura. Las decisiones aquí son obligatorias; lo no especificado queda a criterio del implementador, priorizando simplicidad.

## 1. Objetivo
Bot de atención al cliente por WhatsApp para un centro médico de especialidades en Costa Rica. Responde solo a los pacientes que quieren **agendar** o **consultar servicios**. Sin modelos de lenguaje de pago: funciona con menús, botones/listas interactivas de WhatsApp y detección de intención por palabras clave. Todo el texto al paciente va en español de Costa Rica, trato de "usted", tono cordial y breve.

## 2. Stack
- Node.js >= 20, TypeScript estricto, módulos ESM.
- Express para el webhook.
- `google-auth-library` + `fetch` nativo contra la API REST de Google Calendar v3 (NO usar el paquete `googleapis`, es muy pesado).
- `zod` para validar configuración y variables de entorno; `dotenv`.
- `vitest` para pruebas. ESLint opcional; no bloquear por ello.
- Sin base de datos: sesiones en memoria con TTL detrás de una interfaz `SessionStore` (para poder cambiar a Redis después).
- Sin dependencias nativas (nada que requiera compilación).

## 3. Estructura
```
src/
  index.ts                 arranque del servidor
  env.ts                   variables de entorno validadas con zod
  config/clinic.ts         carga y valida config/centro.json
  whatsapp/
    webhook.ts             GET verificación + POST recepción (valida X-Hub-Signature-256 sobre el cuerpo crudo)
    parser.ts              normaliza mensajes entrantes (text, button_reply, list_reply; ignora statuses)
    client.ts              envío: texto, botones (máx. 3), lista (máx. 10 filas), marcar leído
    types.ts
  engine/
    engine.ts              máquina de estados; función pura-ish: (sesión, mensaje entrante) -> respuestas + nueva sesión
    intents.ts             normalización (minúsculas, sin tildes) y detección por palabras clave
    states/                un archivo por flujo
    messages.ts            TODOS los textos al paciente centralizados aquí
  agenda/
    provider.ts            interfaz AgendaProvider
    googleCalendar.ts      implementación Google Calendar
    memory.ts              implementación en memoria (pruebas y simulador)
    siku.ts                esqueleto con TODO: lanza "no implementado" (se conectará cuando Siku entregue API)
    slots.ts               cálculo de espacios libres (función pura)
  sessions/store.ts        SessionStore + implementación en memoria con TTL
  util/                    fechas (zona America/Costa_Rica), logger que enmascara teléfonos
  cli/chat.ts              simulador en terminal
config/centro.json         datos de EJEMPLO del centro (claramente ficticios)
docs/                      guías
test/
```

## 4. Canal WhatsApp (Cloud API oficial, en modo coexistencia)
- Webhook `GET /webhook` (verificación con `hub.verify_token`) y `POST /webhook`.
- Validar firma `X-Hub-Signature-256` con `WHATSAPP_APP_SECRET`; rechazar 401 si no coincide. Responder 200 de inmediato y procesar después.
- Deduplicar por id de mensaje (caché en memoria con TTL).
- Versión de Graph API configurable por `WHATSAPP_API_VERSION` (no fijar suposiciones sobre cuál es la vigente; poner un valor por defecto y documentar que se revise).
- **Coexistencia**: el centro seguirá usando la app WhatsApp Business en el celular con el mismo número. Cuando llegue un evento de eco de mensaje enviado desde la app (campo de webhook `smb_message_echoes`; aislar el parseo en una función para ajustarlo fácilmente), significa que recepción respondió a mano: el bot debe **pausarse para esa conversación** durante `HUMAN_PAUSE_MINUTES` (por defecto 120). Mientras esté en pausa, el bot no responde a ese paciente.
- El bot solo responde a mensajes entrantes (dentro de la ventana de 24 h); no envía plantillas ni inicia conversaciones.
- Tipos no soportados (audio, imagen, documento, ubicación): responder que solo se atiende por texto y ofrecer el menú o recepción.

## 5. Flujos de conversación
Menú principal (lista interactiva): Agendar cita · Especialidades y precios · Horario y ubicación · Mis citas / cancelar · Hablar con recepción.

1. **Agendar**: especialidad → médico (o "cualquiera", se omite si solo hay uno) → día (próximos días con disponibilidad) → hora (lista; paginar con "Ver más horarios" si hay más de 9) → nombre completo → (cédula solo si `pedirCedula` es true en la config) → resumen y confirmación con botones Confirmar / Cambiar / Cancelar → crear cita.
   - Volver a verificar disponibilidad justo antes de crear; si el espacio se ocupó, disculparse y ofrecer otros horarios.
   - Atajo: si el primer mensaje ya nombra una especialidad ("quiero cita con cardiología"), saltar directo a ese paso.
   - Límite: máximo `maxCitasActivasPorTelefono` (por defecto 2) citas futuras por número.
2. **Consultar servicios**: lista de especialidades; al elegir una, mostrar descripción, precio, duración, médicos y botón "Agendar".
3. **Horario y ubicación**: horario, dirección, teléfono, enlace de mapa, formas de pago (desde config).
4. **Mis citas**: lista de citas futuras del número; elegir una → cancelar con confirmación.
5. **Recepción (humano)**: mensaje de que recepción le atenderá por este mismo chat en horario de atención; marcar sesión `HUMANO` y pausar el bot `HUMAN_PAUSE_MINUTES`.

Reglas globales (se evalúan antes que el estado actual):
- "menú", "inicio", "hola" → menú principal. "salir"/"cancelar" dentro de un flujo → abandona el flujo.
- "recepción", "asesor", "humano", "persona" → flujo 5.
- **Urgencias**: palabras como "emergencia", "urgencia", "dolor de pecho", "no puedo respirar", "sangrado", "desmayo", "infarto", "suicid…" → responder de inmediato que este canal no atiende emergencias, que llame al **9-1-1** o acuda al servicio de emergencias más cercano, y pasar a recepción. Lista configurable.
- **Límite médico**: el bot nunca da diagnósticos, interpretación de síntomas, medicación ni recomendaciones clínicas. Ante preguntas médicas ("qué tomo", "qué tengo", "es grave") responde que no puede orientar clínicamente y ofrece agendar o hablar con recepción.
- Mensaje no entendido: repreguntar mostrando opciones; al segundo fallo consecutivo ofrecer recepción.
- Sesión expira tras `SESSION_TTL_MINUTES` (por defecto 30) de inactividad.
- Primer contacto: saludo con el nombre del centro + aviso breve de privacidad (los datos se usan solo para gestionar la cita; Ley 8968).

## 6. Agenda
```ts
interface AgendaProvider {
  getAvailableSlots(doctorId: string, date: string /* YYYY-MM-DD */): Promise<Slot[]>;
  createAppointment(input: NewAppointment): Promise<Appointment>;
  listAppointments(phone: string): Promise<Appointment[]>; // solo futuras
  cancelAppointment(id: string, phone: string): Promise<void>;
}
```
Proveedor elegido por `AGENDA_PROVIDER` = `google` | `memory` | `siku`.

### Google Calendar (provisional mientras se obtiene acceso a Siku)
- Autenticación con **cuenta de servicio** (JSON en ruta `GOOGLE_SERVICE_ACCOUNT_FILE` o contenido en `GOOGLE_SERVICE_ACCOUNT_JSON`). Un calendario por médico (`calendarId` en la config), compartido con el correo de la cuenta de servicio con permiso de edición.
- Disponibilidad = horario de atención del médico (config, por día de semana) partido en bloques de `duracionMin` de la especialidad, menos los intervalos ocupados que devuelve `freeBusy.query`. Excluir espacios a menos de `anticipacionMinHoras` (2) y más allá de `diasMaxAdelanto` (30). Respetar `feriados` (lista de fechas en config).
- Zona horaria fija `America/Costa_Rica` (UTC-6, sin horario de verano). Hacer el cálculo de slots como función pura y probada.
- Cita = evento con título `"[POR CONFIRMAR] Especialidad – Nombre del paciente"`, descripción con nombre, teléfono y (si aplica) cédula, y `extendedProperties.private` con `phone`, `doctorId`, `specialtyId`, `source=bot`. `listAppointments` busca por `privateExtendedProperty=phone=...`. Cancelar = borrar el evento, verificando que el teléfono coincida.
- **Modo de confirmación** `CONFIRMATION_MODE` = `recepcion` (por defecto) | `auto`. En `recepcion` el título lleva `[POR CONFIRMAR]` y al paciente se le dice que la cita queda **reservada y pendiente de confirmación por recepción**; en `auto` no lleva prefijo y se le dice que quedó confirmada. Razón: la agenda real del centro vive en Siku y Google Calendar no ve esas citas, así que recepción debe validar para evitar choques.
- Errores de la API: reintento simple una vez; si falla, disculpa al paciente y oferta de recepción. Nunca dejar al paciente sin respuesta.

## 7. Configuración del centro (`config/centro.json`)
Validada con zod al arrancar (fallar con mensaje claro). Incluye: nombre, dirección, teléfono, enlace de mapa, horario general, formas de pago, `pedirCedula`, `feriados`, palabras de urgencia adicionales, y `especialidades[]` con `id`, `nombre`, `descripcion`, `palabrasClave[]`, `precio` (texto libre, p. ej. "₡35 000"), `duracionMin`, `medicos[]` con `id`, `nombre`, `calendarId`, `horario` por día de la semana. Entregar con datos de EJEMPLO evidentemente ficticios ("Centro Médico Ejemplo", 4 especialidades, 5 médicos) y un comentario en el README de que deben reemplazarse.

## 8. Seguridad y privacidad
- Ningún secreto en el repo. `.env.example` completo y comentado; `.gitignore` con `.env`, credenciales JSON, `node_modules`, `dist`.
- Logs sin datos personales: teléfonos enmascarados (últimos 4 dígitos), sin nombres ni cédulas, sin cuerpo de los mensajes en nivel info.
- Recoger el mínimo de datos: nombre y teléfono (cédula opcional). **No preguntar el motivo de consulta ni síntomas.**
- Límite de tasa básico por teléfono (p. ej. 20 mensajes/minuto) para evitar abuso.

## 9. Simulador en terminal
`npm run chat` abre una conversación en consola contra el motor con el proveedor `memory` (sin WhatsApp ni Google), mostrando botones y listas como opciones numeradas. Debe permitir probar todos los flujos sin credenciales.

## 10. Pruebas (vitest) — obligatorias y en verde
- Cálculo de slots (horario, ocupados, anticipación, feriados, límites de día).
- Detección de intención (tildes, mayúsculas, sinónimos, urgencias, preguntas médicas).
- Flujos completos del motor con proveedor en memoria: agendar feliz, atajo por especialidad, espacio ocupado al confirmar, cancelar cita, no entendido x2 → recepción, urgencia, expiración de sesión, límite de citas.
- Webhook: verificación GET, firma válida/ inválida, deduplicación, pausa por eco de recepción.
- Proveedor Google Calendar con `fetch` simulado (sin red).

## 11. Documentación (en español)
- `README.md`: qué es, arquitectura en un diagrama simple de texto, cómo correr (`npm install`, `npm run chat`, `npm test`, `npm run dev`, `npm run build && npm start`), variables de entorno, cómo editar `centro.json`, límites del bot.
- `docs/GOOGLE_CALENDAR.md`: crear proyecto y cuenta de servicio, habilitar Calendar API, compartir cada calendario, obtener `calendarId`.
- `docs/WHATSAPP.md`: pasar a WhatsApp Business si usan el normal, alta en Meta Business, vincular el número por **coexistencia**, configurar webhook y suscripciones (`messages` y ecos), token permanente, y advertencia de verificar en la documentación oficial de Meta porque los pasos y requisitos cambian.
- `docs/DESPLIEGUE.md`: opciones (cualquier host con HTTPS), `Dockerfile` incluido, variables.
- `docs/SIKU.md`: qué falta para conectar Siku y qué métodos de `AgendaProvider` hay que implementar.
- `CLAUDE.md`: contexto del proyecto, comandos, convenciones y reglas (límite médico, privacidad, textos solo en `messages.ts`) para continuar el trabajo con Claude Code.

## 12. Criterios de aceptación
- `npm install`, `npm run build` y `npm test` terminan sin errores.
- `npm run chat` permite agendar y cancelar una cita de punta a punta.
- El servidor arranca con `AGENDA_PROVIDER=memory` sin credenciales de Google.
- No hay secretos ni datos reales de pacientes en el repositorio.
