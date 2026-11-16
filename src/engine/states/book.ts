import { findDoctor, findSpecialty, type Doctor, type Specialty } from '../../config/clinic.js';
import { SlotTakenError } from '../../agenda/provider.js';
import { doctorWorksOn } from '../../agenda/slots.js';
import { addDays, formatTime12, todayCR } from '../../util/dates.js';
import { isNo, isYes } from '../intents.js';
import { describeAppointment, ID, M } from '../messages.js';
import { newBooking, type Incoming, type Outgoing, type Session } from '../types.js';
import { abandonFlow, pickOption, resetFlow, type EngineContext, type StepResult } from './common.js';

const PAGE_SIZE = 9; // 9 filas + "Ver más" = 10, el máximo de una lista de WhatsApp
const DAY_BATCH = 7;

// --- Utilidades -------------------------------------------------------------

function currentSpecialty(ctx: EngineContext, s: Session): Specialty | undefined {
  return s.booking.especialidadId ? findSpecialty(ctx.clinic, s.booking.especialidadId) : undefined;
}

/** Médicos entre los que se busca disponibilidad ("cualquiera" = todos los de la especialidad). */
function candidateDoctors(spec: Specialty, medicoId: string | undefined): Doctor[] {
  return medicoId && medicoId !== 'any' ? spec.medicos.filter((m) => m.id === medicoId) : spec.medicos;
}

interface DaySlot {
  time: string;
  doctorId: string;
}

/** Horarios de un día, unidos entre médicos candidatos (si varios coinciden, gana el primero). */
async function loadDaySlots(ctx: EngineContext, spec: Specialty, medicoId: string | undefined, date: string): Promise<DaySlot[]> {
  const doctors = candidateDoctors(spec, medicoId).filter((d) => doctorWorksOn(d, date, ctx.clinic.feriados));
  const perDoctor = await Promise.all(doctors.map((d) => ctx.agenda.getAvailableSlots(d.id, date)));
  const byTime = new Map<string, DaySlot>();
  for (const slots of perDoctor) {
    for (const slot of slots) if (!byTime.has(slot.time)) byTime.set(slot.time, { time: slot.time, doctorId: slot.doctorId });
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

// --- Inicio y selección de especialidad ------------------------------------

export async function startBooking(ctx: EngineContext, s: Session, especialidadId?: string): Promise<Outgoing[]> {
  resetFlow(s);
  const active = await ctx.agenda.listAppointments(s.phone);
  if (active.length >= ctx.clinic.maxCitasActivasPorTelefono) {
    return [M.bookingLimit(ctx.clinic.maxCitasActivasPorTelefono)];
  }
  const spec = especialidadId ? findSpecialty(ctx.clinic, especialidadId) : undefined;
  if (spec) return selectSpecialty(ctx, s, spec);
  s.state = 'AGENDAR_ESPECIALIDAD';
  return [M.askSpecialty(ctx.clinic)];
}

async function selectSpecialty(ctx: EngineContext, s: Session, spec: Specialty): Promise<Outgoing[]> {
  s.booking = { ...newBooking(), especialidadId: spec.id };
  if (spec.medicos.length === 1) {
    s.booking.medicoId = spec.medicos[0]!.id;
    return showDays(ctx, s);
  }
  s.state = 'AGENDAR_MEDICO';
  return [M.askDoctor(spec)];
}

export function repromptSpecialty(ctx: EngineContext): Outgoing[] {
  return [M.askSpecialty(ctx.clinic)];
}

export async function handleSpecialty(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  const options = ctx.clinic.especialidades.map((e) => ({ id: ID.esp(e.id), keys: [e.nombre, ...e.palabrasClave] }));
  const picked = pickOption(incoming, options);
  const spec = picked ? findSpecialty(ctx.clinic, picked.slice('esp:'.length)) : undefined;
  return spec ? selectSpecialty(ctx, s, spec) : null;
}

// --- Médico -----------------------------------------------------------------

export function repromptDoctor(ctx: EngineContext, s: Session): Outgoing[] {
  const spec = currentSpecialty(ctx, s);
  return spec ? [M.askDoctor(spec)] : repromptSpecialty(ctx);
}

export async function handleDoctor(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  const spec = currentSpecialty(ctx, s);
  if (!spec) return null;
  const options = [
    { id: ID.medAny, keys: ['cualquiera', 'cualquier medico', 'cualquier doctor', 'el primero', 'me da igual'] },
    ...spec.medicos.map((m) => ({ id: ID.med(m.id), keys: [m.nombre, m.nombre.replace(/^(dra?\.)\s*/i, '')] })),
  ];
  const picked = pickOption(incoming, options);
  if (!picked) return null;
  s.booking.medicoId = picked === ID.medAny ? 'any' : picked.slice('med:'.length);
  return showDays(ctx, s);
}

// --- Día --------------------------------------------------------------------

/** Busca hasta 10 días con espacios desde `cursor` (offset en días desde hoy). */
async function findDays(ctx: EngineContext, spec: Specialty, medicoId: string | undefined, cursor: number) {
  const today = todayCR(ctx.now());
  const doctors = candidateDoctors(spec, medicoId);
  const found: Array<{ date: string; offset: number }> = [];

  for (let offset = cursor; offset <= ctx.clinic.diasMaxAdelanto && found.length < 10; offset += DAY_BATCH) {
    const batch: Array<{ date: string; offset: number }> = [];
    for (let o = offset; o < offset + DAY_BATCH && o <= ctx.clinic.diasMaxAdelanto; o++) {
      const date = addDays(today, o);
      if (doctors.some((d) => doctorWorksOn(d, date, ctx.clinic.feriados))) batch.push({ date, offset: o });
    }
    const results = await Promise.all(batch.map((day) => loadDaySlots(ctx, spec, medicoId, day.date)));
    batch.forEach((day, i) => {
      if ((results[i] ?? []).length > 0 && found.length < 10) found.push(day);
    });
  }
  return found;
}

async function showDays(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  const spec = currentSpecialty(ctx, s);
  if (!spec) return repromptSpecialty(ctx);
  const found = await findDays(ctx, spec, s.booking.medicoId, s.booking.dayCursor);
  if (found.length === 0) {
    if (s.booking.dayCursor > 0) {
      s.booking.dayCursor = 0;
      return showDays(ctx, s);
    }
    resetFlow(s);
    return [M.noAvailability(spec, ctx.clinic.diasMaxAdelanto)];
  }
  const hasMore = found.length > PAGE_SIZE;
  const page = found.slice(0, PAGE_SIZE);
  s.state = 'AGENDAR_DIA';
  s.booking.slotPage = 0;
  // El siguiente bloque empieza en el primer día que no se mostró.
  s.booking.dayCursor = hasMore ? found[PAGE_SIZE]!.offset : 0;
  return [M.askDay(page.map((d) => d.date), hasMore)];
}

export async function repromptDay(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  s.booking.dayCursor = 0;
  return showDays(ctx, s);
}

export async function handleDay(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  if (incoming.type === 'choice' && incoming.id === ID.diaMas) return showDays(ctx, s);
  if (incoming.type === 'choice' && incoming.id.startsWith('dia:')) {
    const date = incoming.id.slice('dia:'.length);
    // Se valida contra una fecha realmente ofrecida (dentro del horizonte), no se confía en el id.
    const offsetOk = date >= todayCR(ctx.now()) && date <= addDays(todayCR(ctx.now()), ctx.clinic.diasMaxAdelanto);
    if (!offsetOk) return null;
    s.booking.date = date;
    s.booking.slotPage = 0;
    return showHours(ctx, s);
  }
  return null;
}

// --- Hora -------------------------------------------------------------------

async function showHours(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  const spec = currentSpecialty(ctx, s);
  const date = s.booking.date;
  if (!spec || !date) return showDays(ctx, s);

  const slots = await loadDaySlots(ctx, spec, s.booking.medicoId, date);
  if (slots.length === 0) {
    delete s.booking.date;
    s.booking.dayCursor = 0;
    return [M.dayFull(), ...(await showDays(ctx, s))];
  }

  const pages = Math.ceil(slots.length / PAGE_SIZE);
  // Con más de 9 horarios se pagina: 9 filas y "Ver más horarios" (la última página no lo lleva).
  const paginated = slots.length > PAGE_SIZE;
  if (s.booking.slotPage >= pages) s.booking.slotPage = 0;
  const pageSlots = paginated ? slots.slice(s.booking.slotPage * PAGE_SIZE, (s.booking.slotPage + 1) * PAGE_SIZE) : slots;
  const more = paginated && s.booking.slotPage < pages - 1;

  const showDoctor = !s.booking.medicoId || s.booking.medicoId === 'any';
  s.state = 'AGENDAR_HORA';
  return [
    M.askHour(
      date,
      pageSlots.map((slot) => ({
        time: slot.time,
        ...(showDoctor ? { doctor: findDoctor(ctx.clinic, slot.doctorId)?.doctor.nombre ?? '' } : {}),
      })),
      more,
    ),
  ];
}

export async function repromptHour(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  return showHours(ctx, s);
}

function timeKeys(time: string): string[] {
  const [h, m] = time.split(':') as [string, string];
  const withoutZero = `${Number(h)}:${m}`;
  return [time, withoutZero, formatTime12(time)];
}

export async function handleHour(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  const spec = currentSpecialty(ctx, s);
  const date = s.booking.date;
  if (!spec || !date) return null;

  if (incoming.type === 'choice' && incoming.id === ID.horaMas) {
    s.booking.slotPage += 1;
    return showHours(ctx, s);
  }

  const slots = await loadDaySlots(ctx, spec, s.booking.medicoId, date);
  const picked = pickOption(
    incoming,
    slots.map((slot) => ({ id: ID.hora(slot.time), keys: timeKeys(slot.time) })),
  );

  if (!picked) {
    // Un id de hora que ya no existe significa que se ocupó mientras el paciente decidía.
    if (incoming.type === 'choice' && incoming.id.startsWith('hora:')) return slotTaken(ctx, s);
    return null;
  }
  const time = picked.slice('hora:'.length);
  const slot = slots.find((x) => x.time === time)!;
  s.booking.time = time;
  s.booking.doctorId = slot.doctorId;
  s.state = 'AGENDAR_NOMBRE';
  return [M.askName()];
}

async function slotTaken(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  delete s.booking.time;
  delete s.booking.doctorId;
  s.booking.slotPage = 0;
  return [M.slotTaken(), ...(await showHours(ctx, s))];
}

// --- Nombre y cédula --------------------------------------------------------

export function repromptName(): Outgoing[] {
  return [M.askName()];
}

export function repromptCedula(): Outgoing[] {
  return [M.askCedula()];
}

const NAME_RE = /^[\p{L}][\p{L}'’.\- ]*$/u;

export function parseName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim();
  const words = name.split(' ').filter((w) => w.replace(/[^\p{L}]/gu, '').length >= 2);
  if (name.length < 5 || name.length > 80 || !NAME_RE.test(name) || words.length < 2) return null;
  return name;
}

export function parseCedula(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  return /^\d{9,12}$/.test(digits) ? digits : null;
}

export async function handleName(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  if (incoming.type !== 'text') return null;
  const name = parseName(incoming.text);
  if (!name) return { retry: [M.invalidName()] };
  s.booking.nombre = name;
  if (ctx.clinic.pedirCedula) {
    s.state = 'AGENDAR_CEDULA';
    return [M.askCedula()];
  }
  return showSummary(ctx, s);
}

export async function handleCedula(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  if (incoming.type !== 'text') return null;
  const cedula = parseCedula(incoming.text);
  if (!cedula) return { retry: [M.invalidCedula()] };
  s.booking.cedula = cedula;
  return showSummary(ctx, s);
}

// --- Resumen y confirmación -------------------------------------------------

function showSummary(ctx: EngineContext, s: Session): Outgoing[] {
  const b = s.booking;
  const found = b.doctorId ? findDoctor(ctx.clinic, b.doctorId) : undefined;
  if (!found || !b.date || !b.time || !b.nombre) return abandonFlow(s);
  s.state = 'AGENDAR_CONFIRMAR';
  return [M.summary({ spec: found.specialty, doctor: found.doctor, date: b.date, time: b.time, nombre: b.nombre })];
}

export function repromptSummary(ctx: EngineContext, s: Session): Outgoing[] {
  return showSummary(ctx, s);
}

export async function handleConfirm(ctx: EngineContext, s: Session, incoming: Incoming): Promise<StepResult> {
  const choice = incoming.type === 'choice' ? incoming.id : undefined;
  const text = incoming.type === 'text' ? incoming.text : undefined;

  if (choice === ID.conf.cancelar) return abandonFlow(s);
  if (choice === ID.conf.cambiar || (text !== undefined && (isNo(text) || /\b(cambiar|modificar|corregir)\b/i.test(text)))) {
    resetFlow(s);
    s.state = 'AGENDAR_ESPECIALIDAD';
    return [M.restart(), M.askSpecialty(ctx.clinic)];
  }
  if (choice === ID.conf.si || (text !== undefined && isYes(text))) return createBooking(ctx, s);
  return null;
}

async function createBooking(ctx: EngineContext, s: Session): Promise<Outgoing[]> {
  const b = s.booking;
  const found = b.doctorId ? findDoctor(ctx.clinic, b.doctorId) : undefined;
  if (!found || !b.date || !b.time || !b.nombre) return abandonFlow(s);

  // Verificación final de disponibilidad justo antes de crear.
  const slots = await ctx.agenda.getAvailableSlots(found.doctor.id, b.date);
  const slot = slots.find((x) => x.time === b.time);
  if (!slot) return slotTaken(ctx, s);

  try {
    const appointment = await ctx.agenda.createAppointment({
      doctorId: found.doctor.id,
      specialtyId: found.specialty.id,
      start: slot.start,
      patientName: b.nombre,
      phone: s.phone,
      ...(b.cedula ? { cedula: b.cedula } : {}),
    });
    resetFlow(s);
    return [
      M.booked({
        clinic: ctx.clinic,
        detail: describeAppointment(appointment, found.specialty, found.doctor),
        pending: appointment.status === 'por_confirmar',
      }),
    ];
  } catch (error) {
    if (error instanceof SlotTakenError) return slotTaken(ctx, s);
    throw error;
  }
}

