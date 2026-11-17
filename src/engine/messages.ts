// TODOS los textos que ve el paciente viven aquí (español de Costa Rica, trato de "usted").
// Regla del proyecto: nunca escribir texto para el paciente fuera de este archivo.
// Límites de WhatsApp: botones <= 20 caracteres, filas de lista <= 24 (descripción <= 72).

import type { Clinic, Doctor, Specialty } from '../config/clinic.js';
import type { Appointment } from '../agenda/provider.js';
import { formatDateLong, formatDateShort, formatTime12 } from '../util/dates.js';
import type { ButtonOption, ListRow, Outgoing } from './types.js';

// --- Ids de botones y filas (los usan los flujos para reconocer toques) ----

export const ID = {
  menu: { agendar: 'menu:agendar', servicios: 'menu:servicios', horario: 'menu:horario', citas: 'menu:citas', recepcion: 'menu:recepcion', menu: 'menu:menu' },
  esp: (id: string) => `esp:${id}`,
  med: (id: string) => `med:${id}`,
  medAny: 'med:any',
  dia: (date: string) => `dia:${date}`,
  diaMas: 'dia:mas',
  hora: (time: string) => `hora:${time}`,
  horaMas: 'hora:mas',
  conf: { si: 'conf:si', cambiar: 'conf:cambiar', cancelar: 'conf:cancelar' },
  serv: { agendar: 'serv:agendar', otras: 'serv:otras' },
  cita: (id: string) => `cita:${id}`,
  citas: { si: 'citas:si', no: 'citas:no' },
} as const;

// --- Botones reutilizables --------------------------------------------------

const BTN = {
  agendar: { id: ID.menu.agendar, title: 'Agendar cita' },
  menu: { id: ID.menu.menu, title: 'Menú principal' },
  verMenu: { id: ID.menu.menu, title: 'Ver menú' },
  recepcion: { id: ID.menu.recepcion, title: 'Hablar con recepción' },
  misCitas: { id: ID.menu.citas, title: 'Mis citas' },
} satisfies Record<string, ButtonOption>;

const text = (body: string): Outgoing => ({ type: 'text', body });
const buttons = (body: string, ...list: ButtonOption[]): Outgoing => ({ type: 'buttons', body, buttons: list });

// --- Formato de citas -------------------------------------------------------

function hourPhrase(time: string): string {
  const article = time.startsWith('13:') || time.startsWith('01:') ? 'a la' : 'a las';
  return `${article} ${formatTime12(time)}`;
}

export function describeAppointment(a: Pick<Appointment, 'date' | 'time'>, specialty: Specialty | undefined, doctor: Doctor | undefined): string {
  const who = [specialty?.nombre, doctor?.nombre && `con ${doctor.nombre}`].filter(Boolean).join(' ');
  return `${who ? `${who}, el ` : 'El '}${formatDateLong(a.date)} ${hourPhrase(a.time)}`;
}

// --- Mensajes ---------------------------------------------------------------

export const M = {
  // Bienvenida y menú
  greeting: (clinic: Clinic, aiActive = false): Outgoing =>
    text(
      `¡Hola! Bienvenido(a) a *${clinic.nombre}*. Soy el asistente virtual: puedo ayudarle a agendar una cita o a consultar nuestros servicios.\n\n` +
        'Aviso de privacidad: sus datos (nombre y teléfono) se usan únicamente para gestionar su cita, conforme a la Ley 8968 de Protección de la Persona frente al Tratamiento de sus Datos Personales. ' +
        'Por favor no envíe síntomas ni información médica por este medio.\n\n' +
        (aiActive
          ? 'Para entender mejor sus mensajes, estos se procesan de forma automatizada con un servicio de inteligencia artificial.\n\n'
          : '') +
        'Este canal no atiende emergencias: en ese caso llame al 9-1-1.',
    ),

  menu: (): Outgoing => ({
    type: 'list',
    body: '¿En qué le puedo ayudar? Seleccione una opción.',
    buttonLabel: 'Ver opciones',
    sectionTitle: 'Menú principal',
    rows: [
      { id: ID.menu.agendar, title: 'Agendar cita' },
      { id: ID.menu.servicios, title: 'Especialidades y precios' },
      { id: ID.menu.horario, title: 'Horario y ubicación' },
      { id: ID.menu.citas, title: 'Mis citas / cancelar' },
      { id: ID.menu.recepcion, title: 'Hablar con recepción' },
    ],
  }),

  despedida: (): Outgoing => text('Con gusto. Cuando necesite algo más, escríbame «hola» y le muestro el menú.'),
  abandon: (): Outgoing => text('Listo, no se realizó ningún cambio.'),
  anythingElse: (): Outgoing => buttons('¿Le puedo ayudar con algo más?', BTN.agendar, BTN.menu),

  // Casos especiales
  unsupported: (): Outgoing =>
    buttons(
      'Por este medio solo puedo atender mensajes de texto (no audios, imágenes, documentos ni ubicaciones). Puede usar el menú o hablar con recepción.',
      BTN.verMenu,
      BTN.recepcion,
    ),
  notUnderstood: (): Outgoing => text('Disculpe, no logré entender su mensaje. Por favor elija una de las opciones.'),
  offerHuman: (): Outgoing =>
    buttons('Disculpe, sigo sin entender su mensaje. ¿Desea que le atienda una persona de recepción?', BTN.recepcion, BTN.verMenu),
  genericError: (): Outgoing =>
    buttons(
      'Disculpe, tuvimos un inconveniente y no pude completar la gestión. Puede intentarlo de nuevo en unos minutos o comunicarse con recepción.',
      BTN.recepcion,
      BTN.verMenu,
    ),

  urgency: (): Outgoing =>
    text(
      'Este canal *no atiende emergencias*. Si usted o alguien cerca presenta una emergencia, llame de inmediato al *9-1-1* o acuda al servicio de emergencias más cercano.',
    ),
  urgencyHandoff: (): Outgoing => text('Este chat quedará disponible para que recepción pueda atenderle cuando le sea posible.'),

  medicalLimit: (): Outgoing =>
    buttons(
      'Por este medio no puedo dar diagnósticos, orientación sobre síntomas ni indicaciones de medicamentos. Eso lo valora mejor uno de nuestros médicos. ¿Desea agendar una cita o hablar con recepción?',
      BTN.agendar,
      BTN.recepcion,
    ),

  human: (clinic: Clinic): Outgoing =>
    text(
      'Con gusto. Recepción le atenderá por este mismo chat en horario de atención:\n' +
        clinic.horarioGeneral.map((l) => `- ${l}`).join('\n') +
        '\n\nMientras tanto no enviaré más mensajes automáticos en esta conversación.',
    ),

  // Horario y ubicación
  hours: (clinic: Clinic): Outgoing =>
    text(
      `*${clinic.nombre}*\n\n*Horario de atención:*\n${clinic.horarioGeneral.map((l) => `- ${l}`).join('\n')}\n\n` +
        `*Dirección:* ${clinic.direccion}\n*Teléfono:* ${clinic.telefono}\n*Mapa:* ${clinic.enlaceMapa}\n\n` +
        `*Formas de pago:* ${clinic.formasPago.join(', ')}`,
    ),

  // Servicios
  servicesList: (clinic: Clinic): Outgoing => ({
    type: 'list',
    body: 'Estas son nuestras especialidades. Seleccione una para ver los detalles y el precio.',
    buttonLabel: 'Ver especialidades',
    rows: clinic.especialidades.map(specialtyRow),
  }),
  serviceDetail: (spec: Specialty): Outgoing =>
    buttons(
      `*${spec.nombre}*\n${spec.descripcion}\n\n*Precio de la consulta:* ${spec.precio}\n*Duración:* ${spec.duracionMin} minutos\n` +
        `*Médicos:* ${spec.medicos.map((m) => m.nombre).join(', ')}`,
      { id: ID.serv.agendar, title: 'Agendar' },
      { id: ID.serv.otras, title: 'Otras especialidades' },
      BTN.menu,
    ),

  // Agendar
  bookingLimit: (max: number): Outgoing =>
    buttons(
      `Ya tiene ${max} ${max === 1 ? 'cita próxima registrada' : 'citas próximas registradas'} con este número, que es el máximo permitido por este medio. ` +
        'Si necesita otra, puede cancelar una existente o hablar con recepción.',
      BTN.misCitas,
      BTN.recepcion,
    ),
  askSpecialty: (clinic: Clinic): Outgoing => ({
    type: 'list',
    body: '¿Para cuál especialidad desea su cita?',
    buttonLabel: 'Ver especialidades',
    rows: clinic.especialidades.map(specialtyRow),
  }),
  askDoctor: (spec: Specialty): Outgoing => ({
    type: 'list',
    body: `¿Con cuál médico de ${spec.nombre} desea su cita?`,
    buttonLabel: 'Ver médicos',
    rows: [
      { id: ID.medAny, title: 'Cualquiera disponible', description: 'El primer espacio libre' },
      ...spec.medicos.map((m): ListRow => ({ id: ID.med(m.id), title: m.nombre })),
    ],
  }),
  askDay: (dates: string[], more: boolean): Outgoing => ({
    type: 'list',
    body: '¿Qué día le conviene? Estos son los próximos días con espacios disponibles.',
    buttonLabel: 'Ver días',
    rows: [
      ...dates.map((d): ListRow => ({ id: ID.dia(d), title: formatDateShort(d), description: formatDateLong(d) })),
      ...(more ? [{ id: ID.diaMas, title: 'Ver más días' }] : []),
    ],
  }),
  askHour: (date: string, rows: Array<{ time: string; doctor?: string }>, more: boolean, franja?: 'manana' | 'tarde'): Outgoing => ({
    type: 'list',
    body: `Horarios disponibles para el ${formatDateLong(date)}${franja ? (franja === 'manana' ? ', por la mañana' : ', por la tarde') : ''}. Seleccione el que le convenga.`,
    buttonLabel: 'Ver horarios',
    rows: [
      ...rows.map((r): ListRow => ({
        id: ID.hora(r.time),
        title: formatTime12(r.time),
        ...(r.doctor ? { description: r.doctor } : {}),
      })),
      ...(more ? [{ id: ID.horaMas, title: 'Ver más horarios' }] : []),
    ],
  }),
  noAvailability: (spec: Specialty, days: number): Outgoing =>
    buttons(
      `Por ahora no hay espacios disponibles para ${spec.nombre} en los próximos ${days} días. Puede consultar directamente con recepción.`,
      BTN.recepcion,
      BTN.menu,
    ),
  requestedDayUnavailable: (date: string): Outgoing =>
    text(`Lo sentimos, para el ${formatDateLong(date)} no hay espacios disponibles. Estos son los días más cercanos con espacios.`),
  requestedTimeUnavailable: (date: string, time: string): Outgoing =>
    text(`Lo sentimos, el ${formatDateLong(date)} no hay espacio ${hourPhrase(time)}. Estos son los horarios disponibles más cercanos.`),
  requestedFranjaUnavailable: (date: string, franja: 'manana' | 'tarde'): Outgoing =>
    text(`Lo sentimos, para el ${formatDateLong(date)} no quedan espacios ${franja === 'manana' ? 'por la mañana' : 'por la tarde'}. Estos son los horarios disponibles ese día.`),
  dayFull: (): Outgoing => text('Lo sentimos, ese día ya no tiene espacios disponibles.'),
  slotTaken: (): Outgoing => text('Lo sentimos, ese espacio acaba de ser ocupado. Con gusto le muestro otros horarios disponibles.'),
  askName: (): Outgoing => text('Perfecto. ¿Cuál es su nombre completo? Se usará únicamente para registrar la cita.'),
  invalidName: (): Outgoing => text('Por favor escriba su nombre completo (nombre y apellido), solo con letras.'),
  askCedula: (): Outgoing => text('Indique su número de cédula (solo números).'),
  invalidCedula: (): Outgoing => text('No pude reconocer ese número. Por favor escriba su cédula solo con números, sin guiones ni espacios.'),
  summary: (p: { spec: Specialty; doctor: Doctor; date: string; time: string; nombre: string }): Outgoing =>
    buttons(
      'Por favor revise los datos de su cita:\n\n' +
        `*Especialidad:* ${p.spec.nombre}\n*Médico:* ${p.doctor.nombre}\n*Fecha:* ${formatDateLong(p.date)}\n*Hora:* ${formatTime12(p.time)}\n` +
        `*Paciente:* ${p.nombre}\n*Precio de la consulta:* ${p.spec.precio}\n\n¿Desea confirmarla?`,
      { id: ID.conf.si, title: 'Confirmar' },
      { id: ID.conf.cambiar, title: 'Cambiar' },
      { id: ID.conf.cancelar, title: 'Cancelar' },
    ),
  restart: (): Outgoing => text('Con gusto, empecemos de nuevo.'),
  booked: (p: { clinic: Clinic; detail: string; pending: boolean }): Outgoing =>
    buttons(
      (p.pending
        ? 'Su cita quedó *reservada y pendiente de confirmación por recepción*. Recepción la validará y, si hubiera algún inconveniente, se comunicará con usted por este medio.'
        : 'Su cita quedó *confirmada*.') +
        `\n\n${p.detail}\n\nLe esperamos en ${p.clinic.direccion}. Si necesita cancelarla, use «Mis citas».`,
      BTN.menu,
      BTN.misCitas,
    ),

  // Mis citas
  noAppointments: (): Outgoing => buttons('No encontré citas próximas registradas con este número.', BTN.agendar, BTN.menu),
  appointmentsList: (rows: ListRow[]): Outgoing => ({
    type: 'list',
    body: 'Estas son sus próximas citas. Seleccione la que desea cancelar.',
    buttonLabel: 'Ver citas',
    rows,
  }),
  confirmCancel: (detail: string): Outgoing =>
    buttons(`¿Desea cancelar esta cita?\n\n${detail}`, { id: ID.citas.si, title: 'Sí, cancelar cita' }, { id: ID.citas.no, title: 'No, conservarla' }),
  cancelled: (detail: string): Outgoing =>
    buttons(`Su cita fue cancelada:\n${detail}\n\nSi lo desea, puede agendar una nueva.`, BTN.agendar, BTN.menu),
  kept: (): Outgoing => text('Entendido, su cita se mantiene sin cambios.'),
  appointmentNotFound: (): Outgoing =>
    buttons('No pude encontrar esa cita. Es posible que ya haya sido cancelada o modificada.', BTN.misCitas, BTN.recepcion),
};

function specialtyRow(spec: Specialty): ListRow {
  return { id: ID.esp(spec.id), title: spec.nombre, description: `${spec.precio} · ${spec.duracionMin} min` };
}

export function appointmentRow(a: Appointment, spec: Specialty | undefined, doctor: Doctor | undefined): ListRow {
  return {
    id: ID.cita(a.id),
    title: `${formatDateShort(a.date).replace(/^\S+ /, '')}, ${formatTime12(a.time)}`.slice(0, 24),
    description: [spec?.nombre, doctor?.nombre].filter(Boolean).join(' - ') || 'Cita',
  };
}
