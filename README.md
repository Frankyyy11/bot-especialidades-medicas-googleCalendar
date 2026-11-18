# Bot de WhatsApp para centro médico de especialidades

Bot de atención al cliente por WhatsApp (Cloud API oficial de Meta, en **modo coexistencia**) para un centro médico de especialidades en Costa Rica. Atiende solo dos cosas: **agendar citas** y **consultar servicios** (especialidades, precios, horario y ubicación).

- Funciona con menús, botones y listas de WhatsApp, más detección de intención por palabras clave. Opcionalmente (`AI_PROVIDER=gemini`) una **capa de IA** entiende texto libre y suena más natural, sin decidir nada: disponibilidad y citas siguen en el código (ver `docs/IA.md`). Con la IA apagada (valor por defecto) el bot funciona solo con reglas. También opcional y apagada por defecto: **transcripción de notas de voz** (`AUDIO_TRANSCRIPTION=gemini`, ver `docs/AUDIO.md`).
- Todo el texto al paciente va en español de Costa Rica, con trato de "usted".
- La agenda es **provisional en Google Calendar**, detrás de la interfaz `AgendaProvider`, porque más adelante se cambiará a Siku (ver `docs/SIKU.md`).

> **Los datos de `config/centro.json` son de EJEMPLO y ficticios** ("Centro Médico Ejemplo", médicos, precios, teléfonos y `calendarId`). Deben reemplazarse por los datos reales antes de usar el bot con pacientes.

## Arquitectura

```
Paciente (WhatsApp)
      │  mensajes / toques en botones y listas
      ▼
Meta Cloud API ──POST /webhook──► whatsapp/webhook.ts   valida firma, responde 200, deduplica
                                        │
                                        ▼
                                  whatsapp/parser.ts     normaliza (texto, botón, lista, no soportado)
                                        │                 y detecta ecos de recepción (coexistencia)
                                        ▼
                                     bot.ts              límite de tasa → pausa humana → sesión → motor
                                        │                    (IA opcional: ai/ interpreta texto libre; solo
                                        │                     si las reglas no resuelven; ver docs/IA.md)
                  ┌─────────────────────┼─────────────────────┐
                  ▼                     ▼                     ▼
          sessions/store.ts      engine/engine.ts       agenda/provider.ts  (AgendaProvider)
          (memoria + TTL)        reglas globales +        ├─ googleCalendar.ts  (provisional)
                                 flujos en states/        ├─ memory.ts          (pruebas, simulador)
                                 textos: messages.ts      └─ siku.ts            (pendiente)
                                        │
                                        ▼
                                  whatsapp/client.ts → Graph API → Paciente
```

El motor (`engine/engine.ts`) no envía ni guarda nada: recibe `(sesión, mensaje)` y devuelve `(respuestas, nueva sesión)`. Por eso el mismo código corre en el webhook y en el simulador de terminal.

## Cómo correrlo

Requiere Node.js 20 o superior.

```bash
npm install
npm run chat          # simulador en terminal (sin WhatsApp ni Google)
npm test              # pruebas (vitest)
npm run typecheck     # solo verificación de tipos
npm run dev           # servidor con recarga (necesita .env)
npm run build && npm start   # compilar y arrancar en producción
```

Para el servidor, copie `.env.example` a `.env` y complete los valores. La forma más rápida de verlo arrancar, sin credenciales de Google:

```bash
AGENDA_PROVIDER=memory npm run dev
```

(Sin las variables `WHATSAPP_*` el servidor arranca igual, pero el webhook responde 503 y avisa en el log.)

### Simulador

`npm run chat` abre una conversación en consola. Los botones y listas se muestran como opciones numeradas: escriba el número para "tocar" la opción, o escriba texto libre. `/salir` termina. También acepta un guion por entrada estándar:

```bash
npm run chat < test/fixtures/agendar-y-cancelar.txt
AI_PROVIDER=fake CHAT_NOW=2026-11-16T10:00:00-06:00 npm run chat < test/fixtures/ia-simulador.txt   # con IA simulada
```

El simulador usa la IA simulada (`fake`) si `AI_PROVIDER` no está definida; con `AI_PROVIDER=gemini` y la key en `.env` usa Gemini real, y con `AI_PROVIDER=none` solo reglas. El simulador también lee el `.env`: si ahí dice `AI_PROVIDER=none`, corre sin IA y lo avisa al arrancar. En PowerShell: `$env:AI_PROVIDER="fake"; npm run chat` (más detalle en `docs/IA.md`).

## Variables de entorno

Detalle comentado en `.env.example`. Resumen:

| Variable | Por defecto | Para qué |
|---|---|---|
| `AGENDA_PROVIDER` | `google` | `google`, `memory` o `siku` |
| `CONFIRMATION_MODE` | `recepcion` | `recepcion`: cita "por confirmar"; `auto`: se informa como confirmada |
| `GOOGLE_SERVICE_ACCOUNT_FILE` / `_JSON` | – | Credenciales de la cuenta de servicio (solo con `google`) |
| `WHATSAPP_VERIFY_TOKEN` | – | Token de verificación del webhook (lo define usted) |
| `WHATSAPP_APP_SECRET` | – | Valida la firma `X-Hub-Signature-256` |
| `WHATSAPP_ACCESS_TOKEN` | – | Token permanente de la API |
| `WHATSAPP_PHONE_NUMBER_ID` | – | Id del número en Meta |
| `WHATSAPP_API_VERSION` | `v23.0` | Versión de Graph API. Es un valor de partida: **revise cuál es la vigente** |
| `AI_PROVIDER` | `none` | Capa de IA: `none`, `gemini` o `fake` (ver `docs/IA.md`) |
| `AUDIO_TRANSCRIPTION` | `off` | Notas de voz: `off`, `gemini` o `fake` (ver `docs/AUDIO.md`). También `AUDIO_MAX_SECONDS` (60) y `AUDIO_TIMEOUT_MS` (20000) |
| `GEMINI_API_KEY` | – | Key de la API de Gemini (solo con `gemini`; nunca en el repo) |
| `GEMINI_MODEL` | – | **Obligatoria** con `gemini`, sin valor por defecto (los modelos cambian seguido) |
| `AI_TIMEOUT_MS` | `6000` | Tiempo máximo por intento de llamada a la IA |
| `AI_MAX_CALLS_PER_PHONE_PER_DAY` | `40` | Tope diario de llamadas a la IA por teléfono |
| `HUMAN_PAUSE_MINUTES` | `120` | Pausa del bot cuando recepción atiende a mano |
| `SESSION_TTL_MINUTES` | `30` | Inactividad tras la cual se descarta la conversación |
| `RATE_LIMIT_PER_MINUTE` | `20` | Mensajes por minuto por teléfono |
| `CLINIC_CONFIG_PATH` | `config/centro.json` | Ruta de la configuración del centro |
| `PORT`, `LOG_LEVEL` | `3000`, `info` | Servidor y logs |

## Editar `config/centro.json`

Se valida con zod al arrancar; si algo está mal, el programa se detiene con un mensaje que indica el campo. Campos principales:

- Datos del centro: `nombre`, `direccion`, `telefono`, `enlaceMapa`, `horarioGeneral` (líneas de texto), `formasPago`.
- Reglas: `pedirCedula`, `maxCitasActivasPorTelefono` (2), `anticipacionMinHoras` (2), `diasMaxAdelanto` (30), `feriados` (`"AAAA-MM-DD"`), `palabrasUrgencia` (extra; un `*` al final admite cualquier terminación, p. ej. `"asma*"`).
- `especialidades[]`: `id`, `nombre`, `descripcion`, `palabrasClave` (sin importar tildes), `precio` (texto libre), `duracionMin` y `medicos[]`.
- Cada médico: `id`, `nombre`, `calendarId` (solo para Google) y `horario` por día de la semana: `"lunes": ["08:00-12:00", "13:00-16:00"]`. Los días llevan **sin tildes** (`miercoles`, `sabado`). Un día ausente significa que no atiende.
- Máximos por límites de WhatsApp: 10 especialidades y 9 médicos por especialidad.

Los `id` solo admiten minúsculas, números, guion y guion bajo, y no pueden repetirse.

## Qué hace y qué no hace el bot

Hace: agendar (especialidad → médico → día → hora → nombre → confirmación), consultar especialidades y precios, horario y ubicación, ver y cancelar citas, y pasar a recepción.

Reglas que no se negocian:

- **Límite médico**: nunca da diagnósticos, interpreta síntomas, ni habla de medicación o recomendaciones clínicas. Ante esas preguntas ofrece agendar o recepción. Tampoco pregunta el motivo de consulta.
- **Urgencias**: ante palabras como "emergencia" o "dolor de pecho" indica que el canal no atiende emergencias, que llame al 9-1-1, y pasa a recepción.
- **Privacidad**: solo recoge nombre y teléfono (cédula si `pedirCedula`). Los logs enmascaran teléfonos y no incluyen nombres, cédulas ni el texto de los mensajes.
- **IA (si está activa)**: nunca decide ni da datos; no recibe teléfono, nombre, cédula ni datos de citas; no se llama en los pasos de nombre y cédula. En el nivel gratuito de Gemini Google puede usar los mensajes para mejorar sus productos: con pacientes reales use un proyecto con facturación habilitada (ver `docs/IA.md`).
- **Notas de voz (si están activas)**: el audio se envía a Gemini solo para transcribirlo; no se guarda ni se registra; nunca confirma ni cancela citas ni se usa para nombre o cédula. Con pacientes reales exige nivel de pago (ver `docs/AUDIO.md`).

Límites conocidos:

- Solo responde a mensajes entrantes (ventana de 24 h); no envía plantillas ni inicia conversaciones. No hay recordatorios.
- No reprograma: para cambiar una cita, se cancela y se agenda otra.
- Las sesiones y las pausas viven en memoria: se pierden al reiniciar el servidor y no sirven para varias instancias a la vez (para eso, implementar `SessionStore` y `HumanPauseStore` sobre Redis).
- Con Google Calendar, el bot no ve las citas que recepción tenga en Siku; por eso el modo por defecto deja las citas "por confirmar" para que recepción las valide.
- Idioma: solo español.

## Estructura

```
src/engine/       motor, intenciones, messages.ts (todos los textos) y states/ (un archivo por flujo)
src/agenda/       AgendaProvider, slots (función pura), Google Calendar, memoria, Siku
src/whatsapp/     webhook, parser, cliente, límites de WhatsApp
src/ai/           capa de IA opcional: interfaz, guardas, prompt, Gemini (fetch), proveedor simulado
src/sessions/     SessionStore y pausa humana
src/cli/chat.ts   simulador
config/centro.json
docs/             guías de Google Calendar, WhatsApp, despliegue y Siku
test/             pruebas
```

Más documentación: `docs/IA.md`, `docs/AUDIO.md`, `docs/GOOGLE_CALENDAR.md`, `docs/WHATSAPP.md`, `docs/DESPLIEGUE.md`, `docs/SIKU.md` y `CLAUDE.md` (guía para continuar con Claude Code).
