# CLAUDE.md

Contexto para continuar este proyecto con Claude Code. Léalo completo antes de cambiar código. La especificación original está en `SPEC.md`; sus decisiones de arquitectura son obligatorias (no editar ni borrar ese archivo). Sus anexos `SPEC-IA.md` y `SPEC-AUDIO.md` sustituyen solo las decisiones que cada uno indica.

## Qué es

Bot de atención al cliente por WhatsApp (Cloud API oficial, modo coexistencia) para un centro médico de especialidades en Costa Rica. Solo **agendar** y **consultar servicios**. Base por reglas: menús, botones/listas y palabras clave. Encima hay una **capa de IA opcional** (Gemini por REST, `SPEC-IA.md`, `docs/IA.md`) que solo interpreta texto libre y redacta una frase breve; con `AI_PROVIDER=none` (por defecto) o si falla, el bot funciona solo con reglas. Agenda provisional en Google Calendar detrás de `AgendaProvider`; se cambiará a Siku (`docs/SIKU.md`).

Persona que lo mantiene: estudiante de informática que trabaja en terminal. Prefiera comandos de terminal, explique el concepto antes de la sintaxis y proponga cambios por pasos pequeños.

## Comandos

```bash
npm install
npm run chat        # simulador en terminal (agenda en memoria, IA simulada `fake`, sin credenciales; `/audio <ruta>` prueba una nota de voz)
npm test            # vitest (debe quedar en verde)
npm run typecheck   # tsc --noEmit (incluye pruebas)
npm run build       # compila src/ a dist/
npm run dev         # servidor con recarga (necesita .env; AGENDA_PROVIDER=memory evita Google)
```

Antes de dar algo por terminado: `npm run build && npm test`.

## Mapa del código

- `src/engine/engine.ts`: reglas globales (urgencia, recepción, menú, salir, límite médico) y despacho por estado. Devuelve respuestas y la nueva sesión; no tiene efectos secundarios.
- `src/engine/states/`: un archivo por flujo (`book`, `services`, `appointments`, `hours`, `human`, `menu`). Un manejador devuelve respuestas, `{ retry }` o `null` (no entendido).
- `src/engine/intents.ts`: normalización y palabras clave (urgencias, límite médico, intenciones, especialidades).
- `src/engine/messages.ts`: **todos** los textos y los ids de botones/filas.
- `src/agenda/`: `provider.ts` (interfaz y errores), `slots.ts` (cálculo puro), `googleCalendar.ts`, `memory.ts`, `siku.ts`.
- `src/ai/`: capa de IA. `provider.ts` (interfaz, tipos, `AiError`), `guards.ts` (validación zod, guardas de `respuestaBreve`), `prompt.ts` (instrucción de sistema y contexto; el texto del paciente es dato), `gemini.ts` (REST con `fetch`, sin SDK), `fake.ts` (proveedor simulado y `ScriptedAiProvider` para pruebas), `safe.ts` (tiempo máximo + un reintento), `budget.ts` (tope diario por teléfono), `transcribe.ts` (notas de voz: interfaz `Transcriber`, Gemini por REST, simulados, duración y formatos de audio).
- `src/engine/states/assist.ts`: usa la interpretación ya validada dentro del motor (`planAi`, `applyAssist`). El motor **no importa** `src/ai/gemini.ts` ni hace red.
- `src/whatsapp/`: `webhook.ts`, `parser.ts` (incluye `parseAudio`), `client.ts` (envío y `downloadMedia`), `limits.ts`.
- `src/bot.ts`: orquesta (límite de tasa, pausa humana, sesión, motor y la llamada asíncrona a la IA con sus guardas finales). `handleAudio` hace la tubería de notas de voz. Lo usan el webhook y el simulador.
- `src/sessions/store.ts`: `SessionStore` y `HumanPauseStore` (memoria; pensados para cambiarse a Redis).
- `config/centro.json`: datos del centro (los de ejemplo son ficticios).

## Reglas que no se rompen

1. **Límite médico.** El bot nunca da diagnósticos, interpretación de síntomas, medicación ni recomendaciones clínicas. No pregunta el motivo de consulta ni síntomas. Si agrega un flujo o texto, verifique que no cruce esa línea.
2. **Urgencias.** Se evalúan antes que el estado actual; responden con 9-1-1 y pasan a recepción. No relajar esa lista; si acaso ampliarla (`palabrasUrgencia` en la config o `URGENCY_PATTERNS`).
3. **Privacidad.** Mínimo de datos: nombre y teléfono (cédula opcional). Logs sin nombres, cédulas ni cuerpo de mensajes; teléfonos siempre por `logger` (que los enmascara). Nunca `console.log` de datos del paciente. Ningún secreto ni dato real en el repo.
4. **Textos solo en `messages.ts`**, en español de Costa Rica, trato de "usted", tono cordial y breve. Sin emojis salvo que el centro lo pida.
5. **Límites de WhatsApp**: máx. 3 botones (título ≤ 20), listas de máx. 10 filas (título ≤ 24, descripción ≤ 72), cuerpo ≤ 1024. `fitOutgoing` recorta como red de seguridad y las pruebas exigen que el motor ya genere mensajes dentro del límite (`test/helpers.ts`). Si agrega opciones a una lista, pagine.
6. **No agregar el paquete `googleapis`** (pesado); la API de Calendar se usa por `fetch` + `google-auth-library`. Sin dependencias nativas.
7. **El bot solo responde a mensajes entrantes.** No enviar plantillas ni iniciar conversaciones.
8. Agenda en Google: el título lleva `[POR CONFIRMAR]` en `CONFIRMATION_MODE=recepcion`, porque la agenda real vive en Siku y recepción debe validar para evitar choques.

### Reglas de la capa de IA (también obligatorias)

9. **La IA entiende y redacta; el código decide.** Nunca consulta disponibilidad, crea ni cancela citas, ni es fuente de datos: todo dato que ve el paciente sale de `config/centro.json` o de `AgendaProvider`. Crear/cancelar exige siempre el paso de confirmación explícito (botón o "sí"); la IA no puede confirmarlo.
10. **Orden de seguridad.** Urgencias y límite médico se evalúan por reglas ANTES de la IA (`planAi` devuelve `skip`). Si la IA clasifica `urgencia` o `pregunta_medica`, se usan las mismas respuestas fijas: la IA solo puede aumentar la cautela. No relajar `URGENCY_PATTERNS` ni `MEDICAL_PATTERNS`.
11. **Todo lo que sale de la IA no es confiable.** Se valida con zod y se descarta campo por campo (`validateInterpretation`); `respuestaBreve` pasa por `guardBrief` (números solo si están en los datos del centro o en el mensaje del código, sin contenido clínico, sin promesas, ≤300 caracteres, sin enlaces ni emojis) y nunca acompaña urgencia, límite médico, resumen, confirmación ni cancelación. Si se amplían las listas prohibidas, agregar pruebas.
12. **Privacidad con la IA.** Solo se envía el texto del mensaje actual (sin números largos), ≤6 turnos de historial y datos públicos del centro. Nunca teléfono, nombre, cédula ni datos de citas. No se llama en `AGENDAR_NOMBRE` ni `AGENDAR_CEDULA`. No registrar prompts ni respuestas en logs (solo eventos y latencia). **Excepción (SPEC-AUDIO.md):** con `AUDIO_TRANSCRIPTION` activa, el audio de una nota de voz se envía a Gemini únicamente para transcripción literal; no se guarda ni se registra, y con pacientes reales se exige nivel de pago (facturación habilitada).
13. **Fallos silenciosos.** Tiempo agotado, HTTP, JSON inválido, bloqueo o cuota: un reintento como máximo y luego solo reglas; el paciente nunca ve errores técnicos. Las pruebas usan IA simulada o `fetch` simulado, jamás red.
14. **`GEMINI_MODEL` es obligatoria** con `AI_PROVIDER=gemini` y no tiene valor por defecto. La key nunca va en el repo ni en la URL (encabezado `x-goog-api-key`).
15. Todo texto nuevo para el paciente sigue yendo en `messages.ts`; las frases de la IA son un añadido que antecede a esos mensajes, no los reemplaza.
16. **`noDisponible` es una señal, no un dato.** Cuando la IA indica que piden algo que el centro no ofrece, el texto sale de `M.notOffered` con datos de la config y nunca repite palabras de la IA; el motor ignora la señal si las reglas encuentran en el mensaje una especialidad o médico que sí existe (`unavailableKind` en `assist.ts`).
17. **Conversación a mitad de un paso.** Una respuesta conversacional (frase válida + `M.continueStep`, botón `cont:paso`) no cambia el estado, no repite la lista y no cuenta como fallo. En `AGENDAR_CONFIRMAR` y `CITAS_CONFIRMAR` la frase nunca va junto al resumen, y `confirmar`/`negar` de la IA se ignoran ahí.

18. **Horarios sugeridos.** Si el paciente ya indicó franja u hora, `showHours` muestra primero 3 horarios reales (los más cercanos a lo pedido) y "Ver más horarios" abre la lista completa; cualquier hora real del día se sigue aceptando escrita.
19. **Intérprete local primero.** Con Gemini activo, `Bot` recibe `ai.local` (reglas de `src/ai/fake.ts`): una reserva clara se resuelve al instante sin llamar a Gemini y, si Gemini falla o tarda, se usa lo que entendió el intérprete local (evento `ia_local`). Su salida pasa por las mismas validaciones y guardas. Un tiempo agotado no se reintenta. Un fallo transitorio (503 "high demand", red) se reintenta una vez y solo con el tiempo que quede: la espera total nunca pasa de `AI_TIMEOUT_MS` (`src/ai/safe.ts`).
20. **Notas de voz (SPEC-AUDIO.md, `docs/AUDIO.md`).** Apagadas por defecto (`AUDIO_TRANSCRIPTION=off`). El audio solo se convierte en texto (`src/ai/transcribe.ts`, interfaz `Transcriber`) y ese texto entra como un mensaje escrito: urgencias y límite médico por reglas primero, sin excepciones. Además: (a) un audio nunca confirma ni cancela una cita (`viaAudio` en el motor); (b) si fijaría un dato de la reserva, se muestran datos estructurados y se espera el botón `audio:si` (`pendingAudio` guarda solo ids y fechas; nunca se muestra ni se guarda el texto fuera del historial breve); (c) en `AGENDAR_NOMBRE` y `AGENDAR_CEDULA` el audio no se descarga ni se transcribe; (d) logs solo con tokens, duración y latencia; (e) fallo, vacío o audio largo → mensaje amable con recepción y 9-1-1; (f) tope diario compartido con la IA. No agregar banderas tipo "inteligible" a la respuesta del modelo: se midió que las marca mal.

## Convenciones

- TypeScript estricto, ESM: los imports relativos terminan en `.js`.
- Fechas y horas siempre en `America/Costa_Rica` (UTC-6 fijo) mediante `src/util/dates.ts`.
- Lógica de tiempo inyectable (`now`) para poder probarla.
- Cada flujo nuevo lleva pruebas en `test/engine.test.ts` con `createHarness` (agenda en memoria y reloj controlable). Las llamadas a Google se prueban con `fetch` simulado, nunca con red.
- Los ids de botones/filas tienen prefijo (`esp:`, `med:`, `dia:`, `hora:`, `conf:`, `cita:`, `menu:`...) y están en `ID` de `messages.ts`. Los ids con prefijo `menu:` funcionan desde cualquier estado.
- Cambiar de agenda = implementar `AgendaProvider`; el motor no debe importar nada de Google.

## Puntos pendientes de verificar contra documentación oficial

- Formato del evento de eco de coexistencia (`smb_message_echoes`): aislado en `parseEchoRecipients` (`src/whatsapp/parser.ts`).
- Versión vigente de Graph API (`WHATSAPP_API_VERSION`, valor por defecto de ejemplo).
- Requisitos de coexistencia en Costa Rica (`docs/WHATSAPP.md`).
- **Gemini (`src/ai/gemini.ts`)**: la petición y el parseo ya se verificaron contra el servicio real (ver "Verificado contra servicios reales"). Sigue pendiente, porque nunca se vio en una respuesta real: bloqueos de seguridad (`promptFeedback.blockReason`, `finishReason` de bloqueo), partes de razonamiento (`thought`), cuota HTTP 429 y el comportamiento bajo carga. Tampoco hay una evaluación sistemática de qué tan bien entiende el modelo.
- **Media API de WhatsApp real** (`WhatsAppClient.downloadMedia`, `parseAudio`): los dos pasos de descarga, los campos `url`/`mime_type`/`file_size`, los dominios desde los que Meta sirve el archivo y los campos `audio.id`/`audio.mime_type` del webhook. Solo se probó con `fetch` simulado.
- **OGG/Opus real en Gemini**: la transcripción solo se probó con WAV sintético. Falta probar notas de voz reales de WhatsApp (formato, lectura de la duración en `audioDurationSeconds`, ruido y acentos). Se puede hacer con `/audio <ruta>` en el simulador y `AUDIO_TRANSCRIPTION=gemini`.
- Autenticación real con cuenta de servicio de Google: la función `createServiceAccountTokenProvider` usa `google-auth-library`, pero las pruebas la sustituyen por un token falso (no se probó contra Google real).

## Verificado contra servicios reales

- **Gemini, 16 de noviembre de 2026, con `gemini-3.5-flash-lite` (modelo recomendado) y `gemini-3.1-flash-lite`**: ruta `v1beta/models/{modelo}:generateContent`, encabezado `x-goog-api-key`, `systemInstruction`, `responseMimeType` + `responseSchema` (tipos en mayúscula; sin esquema el modelo cambia la estructura), `thinkingConfig.thinkingLevel`, respuesta en `candidates[].content.parts[].text` y errores HTTP 400/404/503. Latencia de 0,6 a 1,2 s. Detalle y tabla de modelos en `docs/IA.md` ("Velocidad").
- Modelos a evitar según esa prueba: `gemini-3.8-flash` (503 "high demand" o sin respuesta en 60 s; fue la causa de los timeouts) y `gemini-2.5-flash-lite` (HTTP 404 para keys nuevas). `thinkingBudget` da HTTP 400 en 3.5-flash-lite: por eso la opción es `GEMINI_THINKING_LEVEL`, opcional y sin valor por defecto.
- Las pruebas automáticas siguen sin usar red. Para repetir una verificación real use el simulador con `AI_PROVIDER=gemini` y solo datos ficticios.
- **Transcripción de audio, 16 de noviembre de 2026, con `gemini-3.5-flash-lite` y solo con voz sintética en WAV**: `inlineData` en `generateContent`, `usageMetadata` (25 tokens por segundo de audio) y respuesta JSON con solo `texto`. Latencia de 4 a 13 s (promedios de 6,5 a 10 s; 12 de 15 respondieron dentro de 20 s). `gemini-3.1-flash-lite` fue más rápido pero inventó texto en silencio. Detalle en `docs/AUDIO.md`.
