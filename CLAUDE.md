# CLAUDE.md

Contexto para continuar este proyecto con Claude Code. Léalo completo antes de cambiar código. La especificación original está en `SPEC.md`; sus decisiones de arquitectura son obligatorias (no editar ni borrar ese archivo).

## Qué es

Bot de atención al cliente por WhatsApp (Cloud API oficial, modo coexistencia) para un centro médico de especialidades en Costa Rica. Solo **agendar** y **consultar servicios**. Sin LLM: menús, botones/listas y palabras clave. Agenda provisional en Google Calendar detrás de `AgendaProvider`; se cambiará a Siku (`docs/SIKU.md`).

Persona que lo mantiene: estudiante de informática que trabaja en terminal. Prefiera comandos de terminal, explique el concepto antes de la sintaxis y proponga cambios por pasos pequeños.

## Comandos

```bash
npm install
npm run chat        # simulador en terminal (agenda en memoria, sin credenciales)
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
- `src/whatsapp/`: `webhook.ts`, `parser.ts`, `client.ts`, `limits.ts`.
- `src/bot.ts`: orquesta (límite de tasa, pausa humana, sesión, motor). Lo usan el webhook y el simulador.
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
- Autenticación real con cuenta de servicio de Google: la función `createServiceAccountTokenProvider` usa `google-auth-library`, pero las pruebas la sustituyen por un token falso (no se probó contra Google real).
