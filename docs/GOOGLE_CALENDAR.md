# Google Calendar (agenda provisional)

El bot usa un **calendario por médico** y una **cuenta de servicio** de Google. Habla con la API REST de Calendar v3 mediante `fetch` (no usa el paquete `googleapis`). Los nombres de pantallas de Google Cloud cambian con frecuencia: si algo no coincide, busque el equivalente en la documentación oficial de Google.

## 1. Proyecto y API

1. Entre a [Google Cloud Console](https://console.cloud.google.com/) y cree un proyecto (p. ej. "bot-centro-medico").
2. En **APIs y servicios → Biblioteca**, busque **Google Calendar API** y habilítela.

## 2. Cuenta de servicio

1. **IAM y administración → Cuentas de servicio → Crear cuenta de servicio**. No necesita roles de proyecto.
2. Dentro de la cuenta, pestaña **Claves → Agregar clave → Crear clave nueva → JSON**. Se descarga un archivo.
3. Anote el correo de la cuenta (termina en `iam.gserviceaccount.com`).

Guarde el JSON **fuera del repositorio**. Hay dos formas de dárselo al bot:

- `GOOGLE_SERVICE_ACCOUNT_FILE=/ruta/segura/cuenta.json`, o
- `GOOGLE_SERVICE_ACCOUNT_JSON=` con el contenido completo en una línea (útil en hosts que solo permiten variables de entorno).

El `.gitignore` ya excluye `.env` y nombres típicos de credenciales, pero la regla es: nunca subir ese archivo.

## 3. Un calendario por médico

1. En [Google Calendar](https://calendar.google.com/) cree un calendario nuevo por cada médico (p. ej. "Citas Dra. Ejemplo"). No use el calendario personal de nadie.
2. En **Configuración y uso compartido del calendario → Compartir con personas o grupos**, agregue el correo de la cuenta de servicio con el permiso **Hacer cambios en eventos**.
3. En **Integrar el calendario**, copie el **ID del calendario** (algo como `abc123@group.calendar.google.com`).
4. Péguelo como `calendarId` del médico en `config/centro.json`.

Si el calendario no está compartido con la cuenta de servicio, el bot no podrá leer la disponibilidad (verá errores de `freeBusy`) y los pacientes recibirán una disculpa con la oferta de recepción.

## 4. Cómo funciona

- **Disponibilidad** = horario del médico en `centro.json` partido en bloques de `duracionMin`, menos los intervalos ocupados que devuelve `freeBusy.query`. Se excluyen espacios a menos de `anticipacionMinHoras` y más allá de `diasMaxAdelanto`, y los `feriados`.
- **Zona horaria**: `America/Costa_Rica` (UTC-6 fijo).
- **Cita** = evento con título `[POR CONFIRMAR] Especialidad – Nombre` (el prefijo solo en `CONFIRMATION_MODE=recepcion`), descripción con nombre, teléfono y cédula (si se pide), y `extendedProperties.private` con `phone`, `doctorId`, `specialtyId` y `source=bot`.
- **Mis citas** busca en cada calendario por `privateExtendedProperty=phone=...`. **Cancelar** borra el evento, tras comprobar que el teléfono coincide.
- Antes de crear la cita se vuelve a consultar `freeBusy`; si el espacio se ocupó, se ofrece otro.
- Un reintento simple ante errores de red, 429 o 5xx.

Cualquier evento que recepción cree a mano en ese calendario también ocupa el espacio (el bot lo ve como "ocupado").

## 5. Datos personales en Calendar

Los eventos contienen nombre y teléfono del paciente. Restrinja quién tiene acceso a esos calendarios a quienes realmente lo necesitan (Ley 8968).
