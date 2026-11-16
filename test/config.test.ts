import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadClinic, parseClinic } from '../src/config/clinic.js';
import { ENV_KEYS, loadEnv, missingWhatsAppVars } from '../src/env.js';
import { maskPhone } from '../src/util/logger.js';
import { SikuAgendaProvider } from '../src/agenda/siku.js';
import { baseClinicJson } from './helpers.js';

describe('config/centro.json de ejemplo', () => {
  it('es válida: 4 especialidades y 5 médicos, datos ficticios', () => {
    const clinic = loadClinic('config/centro.json');
    expect(clinic.nombre).toBe('Centro Médico Ejemplo');
    expect(clinic.especialidades).toHaveLength(4);
    expect(clinic.especialidades.flatMap((e) => e.medicos)).toHaveLength(5);
  });
});

describe('validación de la configuración', () => {
  it('rechaza con mensajes claros', () => {
    const bad = baseClinicJson() as any;
    bad.especialidades[0].medicos[0].horario = { lunes: ['8-12'], miércoles: ['08:00-12:00'] };
    expect(() => parseClinic(bad)).toThrow(/configuración del centro es inválida/);
    try {
      parseClinic(bad);
    } catch (e) {
      expect((e as Error).message).toContain('especialidades.0.medicos.0.horario');
    }
  });

  it('rechaza ids repetidos y más de 9 médicos por especialidad', () => {
    const dup = baseClinicJson() as any;
    dup.especialidades[1].medicos[0].id = 'cardio-1';
    expect(() => parseClinic(dup)).toThrow(/repetido/);

    const many = baseClinicJson() as any;
    many.especialidades[0].medicos = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, nombre: `M${i}`, horario: {} }));
    expect(() => parseClinic(many)).toThrow();
  });

  it('un archivo inexistente o con JSON roto da un error legible', () => {
    expect(() => loadClinic('config/no-existe.json')).toThrow(/No se pudo leer/);
  });
});

describe('variables de entorno', () => {
  it('aplica valores por defecto', () => {
    const env = loadEnv({});
    expect(env).toMatchObject({
      PORT: 3000,
      HUMAN_PAUSE_MINUTES: 120,
      SESSION_TTL_MINUTES: 30,
      CONFIRMATION_MODE: 'recepcion',
      AGENDA_PROVIDER: 'google',
    });
  });

  it('trata las variables vacías como ausentes y valida', () => {
    expect(loadEnv({ GOOGLE_SERVICE_ACCOUNT_FILE: '', PORT: '8080' }).GOOGLE_SERVICE_ACCOUNT_FILE).toBeUndefined();
    expect(() => loadEnv({ AGENDA_PROVIDER: 'excel' })).toThrow(/Variables de entorno inválidas/);
    expect(() => loadEnv({ WHATSAPP_API_VERSION: '23' })).toThrow();
  });

  it('indica qué falta para WhatsApp', () => {
    expect(missingWhatsAppVars(loadEnv({}))).toHaveLength(4);
    expect(missingWhatsAppVars(loadEnv({ WHATSAPP_VERIFY_TOKEN: 'a', WHATSAPP_APP_SECRET: 'b', WHATSAPP_ACCESS_TOKEN: 'c', WHATSAPP_PHONE_NUMBER_ID: 'd' }))).toEqual([]);
  });

  it('.env.example solo usa variables conocidas por el esquema', () => {
    const names = readFileSync('.env.example', 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split('=')[0]!);
    for (const name of names) expect(ENV_KEYS, name).toContain(name);
    for (const key of ENV_KEYS) expect(names, key).toContain(key); // y al revés: todo está documentado
  });
});

describe('privacidad en logs', () => {
  it('enmascara teléfonos dejando los últimos 4 dígitos', () => {
    expect(maskPhone('50688881234')).toBe('****1234');
    expect(maskPhone('+506 8888-1234')).toBe('****1234');
    expect(maskPhone('12')).toBe('****');
  });
});

describe('Siku (esqueleto)', () => {
  it('lanza "no implementado" en todos los métodos', async () => {
    const siku = new SikuAgendaProvider();
    await expect(siku.getAvailableSlots('x', '2026-01-01')).rejects.toThrow(/no está implementado/);
    await expect(siku.listAppointments('1')).rejects.toThrow(/no está implementado/);
    await expect(siku.cancelAppointment('1', '2')).rejects.toThrow(/no está implementado/);
    await expect(
      siku.createAppointment({ doctorId: 'x', specialtyId: 'y', start: 'z', patientName: 'n', phone: '1' }),
    ).rejects.toThrow(/no está implementado/);
  });
});
