# Capa de IA (opcional)

Este documento explica la capa de IA descrita en `SPEC-IA.md`. Es **opcional**: con `AI_PROVIDER=none` (el valor por defecto) el bot funciona exactamente como antes, solo con menús, botones y palabras clave.

## Principio: la IA entiende y redacta; el código decide

- La IA **no** consulta disponibilidad, **no** crea ni cancela citas y **no** es fuente de datos. Todo horario, precio, médico o fecha que ve el paciente sale de `config/centro.json` o de la agenda (`AgendaProvider`).
- Crear o cancelar una cita siempre exige el paso de confirmación explícito (botón o "sí"). La IA no puede confirmarlo.
- Urgencias y límite médico se resuelven **por reglas, antes** de la IA. Si la IA clasifica algo como urgencia o pregunta médica, se responde con las mismas respuestas fijas: la IA solo puede aumentar la cautela.
- Si la IA está apagada, falla, tarda de más o llega al tope diario, el bot sigue solo con reglas y el paciente no ve ningún error técnico.

## Qué hace la IA

1. **Comprensión.** Cuando las reglas no entienden un texto libre (o el texto trae más información de la que las reglas extraen), se le pide una interpretación estructurada: intención, especialidad, médico, fecha, franja (mañana/tarde) y hora. Todo se valida: ids que no existen, fechas pasadas o fuera de `diasMaxAdelanto` se descartan campo por campo. Con eso el bot salta pasos: *"ocupo cita con cardiología el jueves en la tarde"* va directo a los horarios reales de ese jueves por la tarde. Si el día u hora pedidos no están libres, lo dice y ofrece los más cercanos de la agenda.
2. **Redacción natural.** La IA puede añadir una o dos frases cordiales (máx. 300 caracteres) *antes* del mensaje con datos, que sigue saliendo de `src/engine/messages.ts`. Nunca redacta ni modifica: urgencias (9-1-1), límite médico, aviso de privacidad, listas de horarios, resumen de cita, confirmación ni cancelación.

### Guardas sobre la frase de la IA

Se descarta (y se usa solo la plantilla) si falla cualquiera de estas:

1. Todo número (horas, precios, teléfonos, fechas) debe aparecer en los datos del centro o en el mensaje que el código envía junto a la frase. Los números escritos con letras ("treinta mil") se rechazan porque no se pueden cotejar.
2. No puede tener contenido clínico: nombres de medicamentos, dosis, diagnósticos, consejos ("le recomiendo tomar...", "descanse"), ni activar las reglas de urgencia o de pregunta médica (`FORBIDDEN_OUTPUT_PATTERNS` en `src/ai/guards.ts`).
3. Máximo 300 caracteres, sin enlaces ni emojis, y sin promesas ni ofertas ("su cita está confirmada", "le llamaremos", "gratis", "descuento"; `FORBIDDEN_PROMISE_PATTERNS`).

Límite conocido de la guarda de números: comprueba que el número exista *en alguna parte* de los datos del centro, no que corresponda a la especialidad correcta. Una frase que atribuya el precio de otra especialidad pasaría esta guarda. Por eso el precio que importa siempre sale de la plantilla (detalle y resumen de la cita).

## Orden de evaluación

1. Límite de tasa y pausa humana.
2. Urgencias por reglas (la IA no se llama).
3. Reglas globales y estado actual.
4. Límite médico por reglas (la IA no se llama).
5. Solo si lo anterior no resolvió el mensaje: IA.
6. Si la IA clasifica `urgencia` o `pregunta_medica`: respuestas fijas.
7. Sin interpretación útil: comportamiento de "no entendido" de siempre (al segundo fallo, recepción).

Excepción de orden menor: cuando el mensaje empieza una reserva por reglas (p. ej. "cita con cardiología el jueves a las 3") se consulta la IA *antes* para no perder el día y la hora; las urgencias y el límite médico ya se evaluaron antes por reglas.

## Privacidad

- A la IA se envía solo: el texto del mensaje actual (con teléfonos, cédulas y correos reemplazados por `[número]`/`[correo]`), como máximo 6 turnos recientes de la sesión y los datos **públicos** del centro. Nunca teléfono, nombre, cédula ni datos de citas.
- En los pasos que piden nombre o cédula **no se llama a la IA**.
- El historial breve vive en la sesión (memoria, mismo TTL). Los logs registran solo eventos (`ia_usada`, `ia_descartada`, `ia_respuesta_descartada`, `ia_fallo`, `ia_tope_diario`), latencia y la intención; nunca el contenido de prompts ni respuestas.
- El aviso de privacidad del primer contacto agrega, cuando la IA está activa, que los mensajes se procesan de forma automatizada con un servicio de inteligencia artificial.

### ADVERTENCIA: nivel gratuito vs. nivel de pago

En el **nivel gratuito** de la API de Gemini, Google puede usar los mensajes enviados y las respuestas para mejorar sus productos. Con **facturación habilitada (nivel de pago)** no se usan para eso. **Con pacientes reales debe usarse un proyecto con facturación habilitada**; el nivel gratuito es solo para pruebas con datos ficticios. Verifique las condiciones vigentes en https://ai.google.dev/terms porque pueden cambiar.

## Cómo activarla

1. Cree una API key en Google AI Studio (https://aistudio.google.com/apikey) dentro de un proyecto de Google Cloud con facturación habilitada (si el uso será con pacientes reales).
2. Elija un modelo (ver más abajo).
3. En `.env`:

   ```bash
   AI_PROVIDER=gemini
   GEMINI_API_KEY=su-key        # nunca en el repositorio
   GEMINI_MODEL=nombre-del-modelo
   ```

4. Arranque normalmente. El log mostrará `ia_activa` con el modelo y el aviso sobre niveles.

`GEMINI_MODEL` es **obligatoria** y no tiene valor por defecto: los modelos cambian seguido. Si falta, el programa se detiene con un mensaje claro.

### Cómo listar los modelos disponibles

```bash
curl -s -H "x-goog-api-key: $GEMINI_API_KEY" \
  "https://generativelanguage.googleapis.com/v1beta/models" | grep '"name"'
```

Use el nombre sin el prefijo `models/` (ambas formas funcionan). Conviene un modelo rápido y económico que admita salida JSON con esquema; verifique en la documentación oficial (https://ai.google.dev/gemini-api/docs/models) cuáles lo soportan y cuáles están vigentes.

## Variables

| Variable | Por defecto | Para qué |
|---|---|---|
| `AI_PROVIDER` | `none` | `none`, `gemini` o `fake` (simulada, para pruebas y simulador) |
| `GEMINI_API_KEY` | – | Key de la API; viaja en el encabezado `x-goog-api-key`, nunca en la URL |
| `GEMINI_MODEL` | – (obligatoria con `gemini`) | Modelo a usar |
| `AI_TIMEOUT_MS` | `6000` | Tiempo máximo por intento; se hace como máximo un reintento |
| `AI_MAX_CALLS_PER_PHONE_PER_DAY` | `40` | Tope de llamadas por teléfono por día (hora de Costa Rica) |

## Cómo apagarla

Ponga `AI_PROVIDER=none` (o quite la variable) y reinicie. No hace falta tocar nada más: el comportamiento vuelve a ser el de siempre.

## Simulador

`npm run chat` usa la IA simulada (`fake`) por defecto, sin red ni credenciales. Con `AI_PROVIDER=gemini` y la key en `.env` usa Gemini real; con `AI_PROVIDER=none` solo reglas. `CHAT_NOW=2026-11-16T10:00:00-06:00` fija el reloj para guiones reproducibles:

```bash
AI_PROVIDER=fake CHAT_NOW=2026-11-16T10:00:00-06:00 npm run chat < test/fixtures/ia-simulador.txt
```

El proveedor simulado imita a un modelo con reglas simples y, ante un intento de inyección ("ignore las instrucciones..."), se comporta como un modelo **comprometido** a propósito, para demostrar que las guardas y el motor lo neutralizan.

## Fallos

Tiempo agotado, error HTTP, JSON inválido, bloqueo de seguridad o cuota: un reintento como máximo (no se reintenta si el error es permanente, p. ej. HTTP 4xx distinto de 429) y luego caída silenciosa a reglas.

## Límites conocidos

- Si el paciente da fecha u hora pero no especialidad ("quiero cita el jueves"), el bot pide la especialidad y **no recuerda** el día pedido.
- La IA no resuelve ambigüedades por sí sola: ante varias especialidades en un mismo mensaje, se descarta la especialidad.
- La calidad real del entendimiento depende del modelo; las pruebas automáticas usan IA simulada y **no miden** eso.
- **Verificar contra la documentación oficial** (nunca se llamó a Gemini real desde este repositorio): la ruta `v1beta/models/{modelo}:generateContent`, el encabezado `x-goog-api-key`, los campos `systemInstruction`, `generationConfig.responseMimeType`/`responseSchema`, el formato de la respuesta (`candidates[].content.parts[].text`, `finishReason`, `promptFeedback.blockReason`) y que el modelo elegido admita salida estructurada. Todo está aislado en `src/ai/gemini.ts` (`buildGeminiBody`, `buildGeminiRequest`, `geminiResponseSchema`, `parseGeminiResponse`).
