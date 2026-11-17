import { describe, expect, it } from 'vitest';
import { loadClinic } from '../src/config/clinic.js';
import {
  detectMenuIntent,
  isExit,
  isMedicalQuestion,
  isMenuWord,
  isUrgent,
  matchSpecialties,
  normalize,
  wantsHuman,
} from '../src/engine/intents.js';

const clinic = loadClinic('config/centro.json');

describe('normalize', () => {
  it('quita tildes, mayúsculas y signos', () => {
    expect(normalize('  ¡MENÚ, por favor!  ')).toBe('menu por favor');
    expect(normalize('Cardiología')).toBe('cardiologia');
  });
});

describe('menú y navegación', () => {
  it.each(['hola', 'HOLA', 'Menú', 'menu', 'inicio', 'Buenas tardes', 'buenos días', 'volver al menú'])('"%s" es palabra de menú', (t) => {
    expect(isMenuWord(t)).toBe(true);
  });
  it('un saludo con una petición no es solo menú', () => {
    expect(isMenuWord('hola quiero una cita')).toBe(false);
  });
  it.each(['recepción', 'Quiero hablar con un asesor', 'necesito una persona', 'humano', 'RECEPCION'])('"%s" pide recepción', (t) => {
    expect(wantsHuman(t)).toBe(true);
  });
  it('"personal" o "personas" no activan recepción por error', () => {
    expect(wantsHuman('datos personales')).toBe(false);
  });
  it('salir/cancelar son salidas', () => {
    expect(isExit('Salir')).toBe(true);
    expect(isExit('CANCELAR')).toBe(true);
    expect(isExit('cancelar mi cita de mañana')).toBe(false);
  });
});

describe('urgencias', () => {
  it.each([
    'Es una EMERGENCIA',
    'necesito una urgencia',
    'tengo dolor de pecho',
    'me duele el pecho muy fuerte',
    'no puedo respirar',
    'tiene un sangrado fuerte',
    'está sangrando',
    'se desmayó mi papá',
    'creo que es un infarto',
    'pensando en suicidarme',
    'tuvo una convulsión',
  ])('detecta: %s', (t) => {
    expect(isUrgent(t)).toBe(true);
  });

  it.each(['quiero una cita', 'cuánto cuesta un examen de sangre', 'necesito cita urgente para el lunes', 'horario'])(
    'no confunde: %s',
    (t) => {
      expect(isUrgent(t)).toBe(false);
    },
  );

  it('admite palabras extra de la configuración (con comodín al final)', () => {
    expect(isUrgent('creo que es una picadura', ['picadura'])).toBe(true);
    expect(isUrgent('ataque de asma', ['asma*'])).toBe(true);
    expect(isUrgent('tengo asmatico', ['asma*'])).toBe(true);
    expect(isUrgent('un asma leve', ['asma'])).toBe(true); // sin comodín: palabra completa
    expect(isUrgent('tengo asmatico', ['asma'])).toBe(false);
  });
});

describe('límite médico', () => {
  it.each([
    '¿Qué tomo para la fiebre?',
    'que tengo doctor',
    'Es grave?',
    'me duele la cabeza hace días',
    'qué medicamento me recomienda',
    'tengo fiebre y tos',
    'puedo tomar ibuprofeno',
  ])('detecta pregunta médica: %s', (t) => {
    expect(isMedicalQuestion(t)).toBe(true);
  });
  it.each(['quiero una cita', 'qué tengo que llevar a la cita', 'cuánto cuesta cardiología'])('no marca: %s', (t) => {
    expect(isMedicalQuestion(t)).toBe(false);
  });
});

describe('intención del menú', () => {
  it.each([
    ['quiero agendar una cita', 'agendar'],
    ['Necesito reservar', 'agendar'],
    ['cuánto cuesta la consulta', 'servicios'],
    ['qué especialidades tienen', 'servicios'],
    ['cuál es el horario', 'horario'],
    ['dónde están ubicados', 'horario'],
    ['dónde queda', 'horario'],
    ['quiero cancelar mi cita', 'citas'],
    ['mis citas', 'citas'],
    ['blablabla', null],
  ])('"%s" -> %s', (t, expected) => {
    expect(detectMenuIntent(t)).toBe(expected);
  });
});

describe('especialidades', () => {
  it('detecta por nombre, sinónimos y sin tildes', () => {
    expect(matchSpecialties('quiero cita con CARDIOLOGÍA', clinic.especialidades).map((e) => e.id)).toEqual(['cardiologia']);
    expect(matchSpecialties('busco un dermatologo', clinic.especialidades).map((e) => e.id)).toEqual(['dermatologia']);
    expect(matchSpecialties('es para mi bebé', clinic.especialidades).map((e) => e.id)).toEqual(['pediatria']);
  });
  it('devuelve varias si el mensaje es ambiguo y ninguna si no hay coincidencia', () => {
    expect(matchSpecialties('cardiología o dermatología', clinic.especialidades)).toHaveLength(2);
    expect(matchSpecialties('hola', clinic.especialidades)).toEqual([]);
  });
});

describe('matchSpecialties: variantes y errores de escritura', () => {
  const specs = [
    { id: 'cardiologia', nombre: 'Cardiología', palabrasClave: ['cardiologia', 'cardiologo', 'corazon'] },
    { id: 'pediatria', nombre: 'Pediatría', palabrasClave: ['pediatria', 'pediatra', 'ninos'] },
  ];
  it('reconoce variantes cercanas', () => {
    expect(matchSpecialties('cita con cardiologica', specs).map((s) => s.id)).toEqual(['cardiologia']);
    expect(matchSpecialties('consulta pediatrica', specs).map((s) => s.id)).toEqual(['pediatria']);
  });
  it('no inventa coincidencias con palabras cortas o distintas', () => {
    expect(matchSpecialties('odontologia no tiene', specs)).toEqual([]);
    expect(matchSpecialties('quiero una cita', specs)).toEqual([]);
    expect(matchSpecialties('cardio', specs)).toEqual([]);
  });
});
