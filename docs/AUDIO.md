# Notas de voz (opcional)

Este documento explica la transcripción de notas de voz descrita en `SPEC-AUDIO.md`. Está **apagada por defecto**: con `AUDIO_TRANSCRIPTION=off` los audios se contestan pidiendo texto, como siempre.

## Idea: el audio solo se convierte en texto

El audio nunca llega al motor del bot. Antes se transcribe, y ese texto entra por la misma puerta que un mensaje escrito. Por eso aplican las mismas reglas: urgencias y límite médico primero, la IA solo interpreta, y los datos que ve el paciente salen de `config/centro.json` y de la agenda.

Recorrido de una nota de voz:

1. Llega el webhook con `type=audio` y el id del archivo.
2. El bot revisa que pueda atenderla: que recepción no tenga la conversación, que no esté en el paso de nombre o cédula y que quede cupo diario.
3. Envía el acuse: *"Recibí su audio, deme un momento."*
4. Descarga el archivo con la Media API de WhatsApp (en memoria; nunca se escribe a disco).
5. Revisa formato y duración. Si es muy largo, no se envía a la IA.
6. Lo transcribe con Gemini.
7. El texto pasa por el flujo normal del bot.

## Lo que un audio no puede hacer

- **Confirmar ni cancelar una cita.** En el resumen de la cita y al confirmar una cancelación, el bot contesta que necesita el botón (o el texto escrito) y vuelve a mostrar el paso. Un error de transcripción ahí crearía o cancelaría una cita.
- **Dar el nombre o la cédula.** En esos pasos el audio ni siquiera se descarga; se pide escribir el dato.
- **Avanzar una reserva sin que el paciente vea lo que se entendió.** Si el audio fija la especialidad, el médico, el día o la hora, el bot muestra esos datos y espera un botón:

  ```
  Esto fue lo que entendí de su audio:

  *Especialidad:* Cardiología
  *Día:* jueves 19 de noviembre
  *Horario:* por la tarde

  ¿Es correcto? Todavía no se ha registrado ninguna cita.
    1) Sí, continuar
    2) No, corregir
  ```

  Se muestran datos de la configuración y fechas ya validadas, nunca el texto transcrito. "Sí, continuar" solo permite avanzar: la agenda se vuelve a consultar, y crear la cita sigue exigiendo el nombre y la confirmación de siempre. Lo entendido vale únicamente para el mensaje siguiente.

Una pregunta dicha por audio ("¿tienen odontología?", "¿cuál es el horario?") se contesta directamente, sin ese paso.

## Privacidad

- El audio se envía a Gemini **únicamente para transcribirlo literalmente**. No se guarda ni se registra.
- El texto transcrito entra al historial breve de la sesión igual que un mensaje escrito (máximo 6 turnos, sin números largos, se borra con la sesión). No va a ningún almacenamiento permanente ni a los logs.
- Los logs llevan solo números: `audio_transcrito` con duración del audio, latencia y tokens de entrada y salida.
- Con la función activa, el aviso de privacidad del primer contacto menciona los audios.

### ADVERTENCIA: nivel de pago obligatorio con pacientes reales

Una nota de voz lleva la voz del paciente y puede incluir datos personales o de salud. En el **nivel gratuito** de la API de Gemini, Google puede usar el contenido enviado para mejorar sus productos; con **facturación habilitada (nivel de pago)** no. Con pacientes reales use siempre un proyecto con facturación habilitada. Verifique las condiciones vigentes en https://ai.google.dev/terms.

## Cómo activarla

En `.env`:

```bash
AUDIO_TRANSCRIPTION=gemini
GEMINI_API_KEY=su-key          # nunca en el repositorio
GEMINI_MODEL=gemini-3.5-flash-lite
```

| Variable | Por defecto | Para qué |
|---|---|---|
| `AUDIO_TRANSCRIPTION` | `off` | `off`, `gemini` o `fake` (simulado, para pruebas y simulador) |
| `AUDIO_MAX_SECONDS` | `60` | Duración máxima; un audio más largo se rechaza con un mensaje amable |
| `AUDIO_TIMEOUT_MS` | `20000` | Tiempo máximo total para descargar y transcribir |
| `AI_MAX_CALLS_PER_PHONE_PER_DAY` | `40` | Tope diario compartido con la IA |

La transcripción no depende de `AI_PROVIDER`: puede estar activa con la IA de interpretación apagada. En ese caso el texto transcrito se resuelve solo con reglas.

**Tope diario.** La transcripción cuenta una llamada. Si después las reglas no entienden el texto y se consulta a la IA, esa cuenta otra: un audio puede gastar dos.

## Límites y fallos

- **Duración.** El webhook de WhatsApp no informa la duración, así que se lee del propio archivo (OGG/Opus y WAV). Si no se puede leer (por ejemplo MP3), se aplica un tope por tamaño.
- **Formatos.** OGG/Opus (las notas de voz de WhatsApp), MP3, AAC, M4A, WAV, WebM y FLAC. Un audio AMR no se admite.
- **Tiempo agotado.** No se reintenta. Un fallo pasajero (HTTP 503, red) se reintenta una sola vez y solo si queda al menos la mitad del tiempo; el máximo total sigue siendo `AUDIO_TIMEOUT_MS`.
- **Cualquier fallo, audio vacío o sin voz:** *"Disculpe, no logré entender su audio. ¿Me lo puede escribir, o prefiere que le atienda recepción? Si se trata de una emergencia, llame al 9-1-1."* El paciente conserva el paso en que estaba.

## Simulador

`/audio <ruta>` envía un archivo como si fuera una nota de voz:

```powershell
# PowerShell (Windows): con Gemini real
$env:AUDIO_TRANSCRIPTION="gemini"; $env:GEMINI_MODEL="gemini-3.5-flash-lite"; npm run chat
```

```
USTED> /audio C:\ruta\a\nota-de-voz.ogg
```

Con Gemini real el simulador muestra una línea con duración, latencia y tokens (nunca el texto). Si `AUDIO_TRANSCRIPTION` no está definida, el simulador usa el transcriptor **simulado**: no escucha nada, devuelve una frase fija y, si le pasa un `.txt`, toma su contenido como lo dicho. Sirve para probar el flujo sin key:

```powershell
$env:AI_PROVIDER="fake"; npm run chat
```

```
USTED> /audio C:\ruta\a\lo-que-dije.txt
```

## Mediciones (16 de noviembre de 2026)

**Todas las mediciones se hicieron con voz sintética**: voz en español generada con Windows, texto ficticio, archivos WAV de 16 kHz. No son notas de voz reales, no tienen ruido de fondo ni acentos variados, y no usan el formato OGG/Opus de WhatsApp. Sirven de referencia, no de garantía.

### Latencia con `gemini-3.5-flash-lite`

Quince audios distintos (cinco por duración), con el transcriptor del bot y tiempo máximo de 20 s, antes de agregar el reintento:

| Duración | Respondieron | Promedio | Peor caso | Fallos |
|---|---|---|---|---|
| 15 s | 5 de 5 | 6,8 s | 9,5 s | ninguno |
| 30 s | 4 de 5 | 10,0 s | 13,4 s | un HTTP 503 |
| 60 s | 3 de 5 | 6,5 s | 8,3 s | un tiempo agotado (20 s) y un HTTP 503 |

- La latencia **no depende de la duración** del audio: depende de la carga del servicio en ese momento.
- En total 12 de 15 respondieron. Los dos 503 volvieron a los 2,5 y 7,8 s; el reintento único que se agregó después cubre ese caso, pero no se volvió a medir con él.
- El paciente espera entre 4 y 13 segundos tras el acuse. Por eso existe el acuse.

### Tokens y costo

Leídos de `usageMetadata`. El audio contó **25 tokens por segundo** (la documentación oficial dice 32); la entrada incluye además unos 123 tokens de instrucciones.

| Duración | Tokens de entrada | Tokens de salida (promedio) | Costo estimado |
|---|---|---|---|
| 15 s | 498 | 52 | US$0,00028 |
| 30 s | 873 | 97 | US$0,00050 |
| 60 s | 1 623 | 199 | US$0,00098 |

Precio usado: US$0,30 por millón de tokens de entrada (mismo precio para texto y audio) y US$2,50 por millón de salida, nivel de pago estándar de `gemini-3.5-flash-lite`, leído en la página oficial de precios el 16 de noviembre de 2026. Los tokens de salida dependen de cuánto se hable. Mil audios de 30 segundos cuestan cerca de US$0,50.

### Calidad observada

- **Transcripciones vacías por una bandera mal usada.** La primera versión pedía un JSON con una bandera aparte (`inteligible`). El modelo la marcaba como falsa en audios perfectamente claros: 3 de 14 en una corrida y 2 de 5 en otra. Al quitarla (la respuesta lleva solo el texto, y "sin voz" es texto vacío) no hubo ninguna vacía en 26 transcripciones, y el silencio y el ruido siguieron devolviendo vacío. Es el formato actual.
- **Transcripciones incompletas.** En algunas corridas el texto salió más corto de lo dicho (por ejemplo 22 palabras donde otras corridas del mismo audio dieron más de 40). Pasó en aproximadamente 1 de cada 12. El modelo no es determinista aunque se pida temperatura 0. La confirmación de lo entendido cubre las reservas; una pregunta cortada puede contestarse a medias.
- **`gemini-3.1-flash-lite` es mucho más rápido pero inventó texto.** Respondió en 1,3 a 2,3 s (con un caso aislado de 22,9 s), pero en dos pruebas con silencio devolvió 12 palabras que nadie dijo. Con `gemini-3.5-flash-lite` el silencio y el ruido devolvieron vacío. Por eso se recomienda el 3.5 aunque sea más lento: en un centro médico, texto inventado es peor que esperar.

## Pendiente de verificar con el servicio real

- **Media API de WhatsApp** (`WhatsAppClient.downloadMedia`): los dos pasos, los campos `url`, `mime_type` y `file_size`, y los dominios desde los que Meta sirve el archivo. Solo se probó con `fetch` simulado.
- **OGG/Opus real en Gemini**: la documentación lo lista como formato admitido, pero solo se probó WAV. Tampoco se probó con una nota de voz real la lectura de la duración del archivo OGG.
- **Voces reales**: ruido de fondo, acentos, gente que habla rápido o bajo.
- Campos `audio.id` y `audio.mime_type` del webhook (`parseAudio` en `src/whatsapp/parser.ts`).

Para probar con notas de voz reales, grábelas con contenido ficticio, páselas a la computadora y use `/audio <ruta>` en el simulador con `AUDIO_TRANSCRIPTION=gemini`.
