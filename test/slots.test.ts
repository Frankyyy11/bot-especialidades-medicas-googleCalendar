import { describe, expect, it } from 'vitest';
import { computeSlots, dayWindow, doctorWorksOn, type ComputeSlotsInput } from '../src/agenda/slots.js';
import { loadClinic } from '../src/config/clinic.js';
import { fromCostaRica, toCostaRica, todayCR } from '../src/util/dates.js';

const rules = { anticipacionMinHoras: 2, diasMaxAdelanto: 30, feriados: ['2026-12-25'] };
const monday10am = new Date('2026-11-16T10:00:00-06:00');

function slots(overrides: Partial<ComputeSlotsInput> = {}) {
  return computeSlots({
    doctorId: 'd1',
    date: '2026-11-17', // martes
    ranges: ['08:00-10:00'],
    duracionMin: 30,
    busy: [],
    now: monday10am,
    rules,
    ...overrides,
  });
}
const times = (list: ReturnType<typeof slots>) => list.map((s) => s.time);

describe('computeSlots', () => {
  it('parte el horario en bloques de la duración', () => {
    expect(times(slots())).toEqual(['08:00', '08:30', '09:00', '09:30']);
  });

  it('no genera un bloque que no cabe completo en el rango', () => {
    expect(times(slots({ ranges: ['08:00-09:45'] }))).toEqual(['08:00', '08:30', '09:00']);
  });

  it('respeta varios rangos en un día (pausa de almuerzo)', () => {
    expect(times(slots({ ranges: ['08:00-09:00', '13:00-14:00'] }))).toEqual(['08:00', '08:30', '13:00', '13:30']);
  });

  it('descarta los intervalos ocupados que se traslapan', () => {
    const busy = [{ start: fromCostaRica('2026-11-17', '08:15').getTime(), end: fromCostaRica('2026-11-17', '09:10').getTime() }];
    // 08:00 (08:00-08:30) traslapa con 08:15; 08:30 y 09:00 también; 09:30 queda libre.
    expect(times(slots({ busy }))).toEqual(['09:30']);
  });

  it('un ocupado que termina justo cuando empieza el bloque no lo bloquea', () => {
    const busy = [{ start: fromCostaRica('2026-11-17', '08:00').getTime(), end: fromCostaRica('2026-11-17', '08:30').getTime() }];
    expect(times(slots({ busy }))).toEqual(['08:30', '09:00', '09:30']);
  });

  it('aplica la anticipación mínima el mismo día', () => {
    // Ahora 10:00 + 2 h = 12:00: el bloque de las 11:30 ya no, el de las 12:00 sí.
    const result = slots({ date: '2026-11-16', ranges: ['11:00-13:00'] });
    expect(times(result)).toEqual(['12:00', '12:30']);
  });

  it('no ofrece fechas pasadas', () => {
    expect(slots({ date: '2026-11-15' })).toEqual([]);
  });

  it('respeta el máximo de días hacia adelante (30)', () => {
    expect(slots({ date: '2026-12-16' }).length).toBeGreaterThan(0); // día 30
    expect(slots({ date: '2026-12-17' })).toEqual([]); // día 31
  });

  it('no ofrece feriados', () => {
    expect(slots({ date: '2026-12-25', now: new Date('2026-12-20T08:00:00-06:00') })).toEqual([]);
  });

  it('devuelve ISO con desfase -06:00 y fin = inicio + duración', () => {
    const [first] = slots();
    expect(first).toMatchObject({
      doctorId: 'd1',
      date: '2026-11-17',
      time: '08:00',
      start: '2026-11-17T08:00:00-06:00',
      end: '2026-11-17T08:30:00-06:00',
    });
  });

  it('sin rangos no hay espacios', () => {
    expect(slots({ ranges: [] })).toEqual([]);
  });
});

describe('zona horaria America/Costa_Rica (UTC-6 fijo)', () => {
  it('convierte instantes UTC a hora de Costa Rica, incluso cruzando de día', () => {
    expect(toCostaRica(new Date('2026-11-17T03:30:00Z'))).toMatchObject({ date: '2026-11-16', time: '21:30' });
    expect(todayCR(new Date('2026-11-17T05:59:00Z'))).toBe('2026-11-16');
    expect(todayCR(new Date('2026-11-17T06:00:00Z'))).toBe('2026-11-17');
  });

  it('dayWindow cubre exactamente el día local', () => {
    expect(dayWindow('2026-11-30')).toEqual({
      timeMin: '2026-11-30T00:00:00-06:00',
      timeMax: '2026-12-01T00:00:00-06:00',
    });
  });
});

describe('doctorWorksOn', () => {
  const clinic = loadClinic('config/centro.json');
  const alma = clinic.especialidades[0]!.medicos[0]!; // lunes, miércoles y viernes
  it('depende del día de la semana y de los feriados', () => {
    expect(doctorWorksOn(alma, '2026-11-16', [])).toBe(true); // lunes
    expect(doctorWorksOn(alma, '2026-11-17', [])).toBe(false); // martes
    expect(doctorWorksOn(alma, '2026-11-16', ['2026-11-16'])).toBe(false);
  });
});
