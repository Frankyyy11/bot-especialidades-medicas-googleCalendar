# Conectar Siku

La agenda real del centro vive en Siku. Mientras no haya acceso a su API, el bot usa Google Calendar (`docs/GOOGLE_CALENDAR.md`). El esqueleto está en `src/agenda/siku.ts`: hoy todos sus métodos lanzan "no implementado". El resto del bot no cambia: solo hay que implementar esa clase.

## Qué falta

1. **Acceso a la API de Siku** y su documentación: autenticación (token, OAuth...), URL base, límites de uso y entorno de pruebas.
2. Confirmar que la API permite, como mínimo:
   - consultar **disponibilidad** (o agendas ocupadas) por profesional y fecha;
   - **crear** una cita con nombre y teléfono del paciente (y cédula si el centro la pide);
   - **listar** citas futuras de un paciente por teléfono (o, si no se puede buscar por teléfono, una forma de etiquetar las citas creadas por el bot para encontrarlas);
   - **cancelar** una cita.
3. El **mapeo** entre los `id` de `config/centro.json` (médicos y especialidades) y los identificadores de profesional y servicio de Siku. Probablemente haya que agregar campos a la config (por ejemplo `sikuId` en cada médico).
4. Decidir si, con Siku, las citas pueden quedar **confirmadas** directamente. Si Siku ve toda la agenda real, ya no hay riesgo de choques y `CONFIRMATION_MODE=auto` tiene sentido.
5. Acuerdo de tratamiento de datos con el proveedor (Ley 8968).

## Qué implementar

La interfaz está en `src/agenda/provider.ts`:

```ts
interface AgendaProvider {
  getAvailableSlots(doctorId: string, date: string): Promise<Slot[]>;
  createAppointment(input: NewAppointment): Promise<Appointment>;
  listAppointments(phone: string): Promise<Appointment[]>;   // solo futuras
  cancelAppointment(id: string, phone: string): Promise<void>;
}
```

Contrato que el motor espera:

- `getAvailableSlots`: `Slot.start`/`end` en ISO con `-06:00`, `date` y `time` en hora de Costa Rica. Devolver `[]` si no hay espacios. Puede reutilizar `computeSlots` de `src/agenda/slots.ts` si Siku solo entrega intervalos ocupados, o mapear directamente si Siku entrega los espacios libres (en ese caso, respetar igualmente anticipación mínima, `diasMaxAdelanto` y feriados).
- `createAppointment`: lanzar `SlotTakenError` si el espacio ya no está libre (el motor se disculpa y ofrece otro horario). Cualquier otro error: lanzar `AgendaError`; el motor responde con disculpa y la oferta de recepción. Devolver `status: 'confirmada'` o `'por_confirmar'`; el mensaje al paciente se ajusta solo.
- `listAppointments`: solo citas futuras de ese teléfono.
- `cancelAppointment`: lanzar `AppointmentNotFoundError` si la cita no existe o **no pertenece a ese teléfono** (nunca cancelar la cita de otra persona).

## Pasos

1. Implementar los cuatro métodos en `src/agenda/siku.ts` (reciba `clinic` en el constructor, como `GoogleCalendarProvider`).
2. Ajustar `src/agenda/index.ts` para construirlo con la configuración necesaria.
3. Agregar sus variables a `src/env.ts` y `.env.example`.
4. Escribir pruebas con `fetch` simulado, siguiendo `test/googleCalendar.test.ts`.
5. Probar con `AGENDA_PROVIDER=siku` contra un entorno de pruebas de Siku (el simulador `npm run chat` usa siempre la agenda en memoria), y retirar la nota de "provisional" de la documentación.
