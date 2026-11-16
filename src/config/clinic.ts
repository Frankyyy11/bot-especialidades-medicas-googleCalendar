import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DATE_RE } from '../util/dates.js';

const id = z.string().regex(/^[a-z0-9_-]+$/, 'solo minúsculas, números, guion y guion bajo');
const rango = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'use el formato "08:00-12:00"')
  .refine((r) => r.slice(0, 5) < r.slice(6), 'la hora final debe ser posterior a la inicial');
const dia = z.array(rango).optional();

/** Días sin tildes; un día ausente significa que el médico no atiende. */
const horarioSemana = z
  .object({
    lunes: dia,
    martes: dia,
    miercoles: dia,
    jueves: dia,
    viernes: dia,
    sabado: dia,
    domingo: dia,
  })
  .strict();

const medico = z.object({
  id,
  nombre: z.string().min(1),
  calendarId: z.string().min(1).optional(), // obligatorio solo con AGENDA_PROVIDER=google
  horario: horarioSemana,
});

const especialidad = z.object({
  id,
  nombre: z.string().min(1),
  descripcion: z.string().min(1),
  palabrasClave: z.array(z.string().min(1)).default([]),
  precio: z.string().min(1),
  duracionMin: z.number().int().min(5).max(480),
  // Máx. 9 para que "Cualquiera" + médicos quepan en una lista de WhatsApp (10 filas).
  medicos: z.array(medico).min(1).max(9),
});

const schema = z
  .object({
    nombre: z.string().min(1),
    direccion: z.string().min(1),
    telefono: z.string().min(1),
    enlaceMapa: z.string().min(1),
    horarioGeneral: z.array(z.string().min(1)).min(1),
    formasPago: z.array(z.string().min(1)).min(1),
    pedirCedula: z.boolean().default(false),
    maxCitasActivasPorTelefono: z.number().int().min(1).default(2),
    anticipacionMinHoras: z.number().min(0).default(2),
    diasMaxAdelanto: z.number().int().min(1).max(365).default(30),
    feriados: z.array(z.string().regex(DATE_RE, 'use el formato AAAA-MM-DD')).default([]),
    /** Frases extra de urgencia. Un asterisco final admite cualquier terminación ("sangrad*"). */
    palabrasUrgencia: z.array(z.string().min(1)).default([]),
    // Máx. 10 para que quepan en una sola lista de WhatsApp.
    especialidades: z.array(especialidad).min(1).max(10),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const [i, esp] of cfg.especialidades.entries()) {
      if (seen.has(esp.id)) ctx.addIssue({ code: 'custom', message: `id de especialidad repetido: ${esp.id}`, path: ['especialidades', i, 'id'] });
      seen.add(esp.id);
    }
    const doctors = new Set<string>();
    for (const [i, esp] of cfg.especialidades.entries()) {
      for (const [j, med] of esp.medicos.entries()) {
        if (doctors.has(med.id)) ctx.addIssue({ code: 'custom', message: `id de médico repetido: ${med.id}`, path: ['especialidades', i, 'medicos', j, 'id'] });
        doctors.add(med.id);
      }
    }
  });

export type Clinic = z.infer<typeof schema>;
export type Specialty = Clinic['especialidades'][number];
export type Doctor = Specialty['medicos'][number];

export function parseClinic(raw: unknown): Clinic {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`La configuración del centro es inválida:\n${detail}`);
  }
  return result.data;
}

export function loadClinic(path: string): Clinic {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`No se pudo leer la configuración del centro en "${path}". Revise CLINIC_CONFIG_PATH.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`"${path}" no es un JSON válido: ${(error as Error).message}`);
  }
  return parseClinic(raw);
}

export function findSpecialty(clinic: Clinic, specialtyId: string): Specialty | undefined {
  return clinic.especialidades.find((e) => e.id === specialtyId);
}

export function findDoctor(clinic: Clinic, doctorId: string): { doctor: Doctor; specialty: Specialty } | undefined {
  for (const specialty of clinic.especialidades) {
    const doctor = specialty.medicos.find((m) => m.id === doctorId);
    if (doctor) return { doctor, specialty };
  }
  return undefined;
}
