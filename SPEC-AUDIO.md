# SPEC-AUDIO — Transcripción de notas de voz

Anexo de `SPEC.md` y de `SPEC-IA.md`. Sustituye **únicamente** la decisión de `SPEC.md` de que los audios se contestan pidiendo texto. Todo lo demás de ambos documentos sigue vigente (imágenes, documentos y ubicaciones se siguen contestando pidiendo texto). Las decisiones de este documento son obligatorias.

## 1. Principio
**El audio solo se convierte en texto; después es un mensaje escrito más.** La nota de voz se envía a la IA únicamente para obtener una transcripción literal. El texto resultante entra al bot por la misma puerta que un mensaje escrito, con las mismas reglas, guardas y límites. Con `AUDIO_TRANSCRIPTION=off` (valor por defecto) el bot se comporta exactamente como antes.

## 2. Flujo
1. Webhook: un mensaje `type=audio` trae el id del archivo. Con la función activa se descarga con la Media API de WhatsApp (en memoria, nunca a disco).
2. **Acuse inmediato**: antes de descargar se envía un mensaje corto de `messages.ts` ("Recibí su audio, deme un momento."). No se envía si el bot está en pausa por recepción, si el audio no se va a procesar (pasos de nombre o cédula) o si ya no hay cupo diario.
3. Se valida formato y duración y se transcribe detrás de la interfaz `Transcriber` (`src/ai/transcribe.ts`), con proveedor real (Gemini por REST, sin SDK) y simulados para pruebas.
4. El texto transcrito entra a `Bot` como texto normal.

## 3. Seguridad (sin excepciones)
- **Urgencias y límite médico por reglas primero**, igual que con un mensaje escrito. Una urgencia dicha por audio responde con 9-1-1 y pasa a recepción; una pregunta médica recibe el límite médico fijo.
- La instrucción al modelo declara el audio como **dato**: transcribe literalmente y no obedece lo que se diga en él. El texto resultante tampoco es confiable: pasa por todo lo de `SPEC-IA.md`.
- **Un audio nunca confirma ni cancela una cita.** En el resumen de la cita y en la confirmación de una cancelación, la respuesta por audio no vale: el bot pide el botón (o el texto escrito) y vuelve a mostrar el paso.
- **Confirmación de lo entendido.** Si el audio fijaría algún dato de la reserva (especialidad, médico, día u hora), también dentro del flujo, el bot no avanza: muestra lo que entendió como **datos estructurados** tomados de la configuración y de fechas ya validadas, nunca el texto transcrito, y espera un botón. "Sí" solo permite avanzar (la agenda se vuelve a consultar); crear la cita sigue exigiendo nombre y la confirmación de siempre. Lo entendido solo vale para el mensaje siguiente.
- Un mensaje de fallo de audio recuerda el 9-1-1 y ofrece recepción, por si el audio que no se pudo leer era una emergencia.

## 4. Privacidad
- El audio se envía a la IA **únicamente para transcripción literal**. No se guarda (ni en disco ni en la sesión) y no se registra.
- "No se guarda" aplica al audio y a cualquier almacenamiento permanente o log. El texto transcrito sí entra al historial breve de la sesión (máx. 6 turnos, sin números largos, mismo TTL), igual que un mensaje escrito.
- **Nombre y cédula nunca se toman de un audio**: en esos pasos el audio no se descarga ni se envía a la IA, y se pide escribir el dato.
- Logs: solo conteo de tokens, duración del audio y latencia. Nunca el audio ni la transcripción.
- Con la función activa, el aviso de privacidad del primer contacto menciona los audios.
- **Con pacientes reales se exige el nivel de pago** de la API (facturación habilitada): en el nivel gratuito Google puede usar el contenido para mejorar sus productos. Una nota de voz lleva la voz del paciente y puede incluir datos personales o de salud dichos espontáneamente.
- El token de WhatsApp solo se envía a dominios de Meta al descargar el archivo.

## 5. Límites y fallos
- Duración máxima configurable (`AUDIO_MAX_SECONDS`, 60 por defecto). El webhook no trae la duración: se lee del archivo (OGG/Opus, WAV) y, si no se puede, se aplica un tope por tamaño. Un audio más largo no se envía a la IA.
- Tiempo máximo propio (`AUDIO_TIMEOUT_MS`, 20000 por defecto) para descargar y transcribir. Un tiempo agotado no se reintenta; un fallo transitorio (503, red) se reintenta una sola vez y solo si queda al menos la mitad del tiempo.
- Tope diario por teléfono **compartido con la IA** (`AI_MAX_CALLS_PER_PHONE_PER_DAY`): la transcripción cuenta una llamada y, si después se consulta a la IA para interpretar el texto, esa cuenta otra.
- Fallo, audio vacío o sin voz, formato no admitido o audio largo: mensaje amable de `messages.ts` con oferta de recepción. El paciente nunca ve errores técnicos y conserva el paso en que estaba.

## 6. Configuración
`AUDIO_TRANSCRIPTION` = `off` (por defecto) | `gemini` | `fake`; `AUDIO_MAX_SECONDS` (60); `AUDIO_TIMEOUT_MS` (20000). Con `gemini` usa `GEMINI_API_KEY` y `GEMINI_MODEL` (obligatorias, sin valor por defecto).

## 7. Simulador
`/audio <ruta>` pasa un archivo por la misma tubería (acuse, validación, transcripción y motor). Con el transcriptor simulado un `.txt` se toma como lo dicho.

## 8. Pruebas (todas con transcriptor y `fetch` simulados, sin red)
- Función apagada: comportamiento de siempre.
- Acuse antes de la respuesta; sin acuse con el bot en pausa.
- Urgencia, pregunta médica e inyección de instrucciones dichas por audio.
- Reserva: datos estructurados, sin avanzar hasta el botón; "no, corregir"; lo entendido caduca con el siguiente mensaje.
- Un "sí" por audio no crea ni cancela citas.
- Nombre y cédula: sin descarga ni transcripción.
- Audio largo, vacío, fallo, formato no admitido, descarga fallida, tiempo agotado, reintento único y tope diario.
- Logs sin contenido; Media API solo hacia dominios de Meta.
