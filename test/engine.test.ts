import { describe, expect, it } from 'vitest';
import { isoCR } from '../src/util/dates.js';
import { allText, bookUntilSummary, clinicWith, createHarness, lastButtons, lastList, PHONE } from './helpers.js';

describe('primer contacto', () => {
  it('saluda con el nombre del centro, aviso de privacidad (Ley 8968) y muestra el menú', async () => {
    const h = createHarness();
    const replies = await h.say('hola');
    const text = allText(replies);
    expect(text).toContain('Centro Médico Ejemplo');
    expect(text).toContain('8968');
    expect(text).toContain('9-1-1');
    expect(lastList(replies).rows.map((r) => r.title)).toEqual([
      'Agendar cita',
      'Especialidades y precios',
      'Horario y ubicación',
      'Mis citas / cancelar',
      'Hablar con recepción',
    ]);
  });

  it('el saludo no se repite en la misma sesión', async () => {
    const h = createHarness();
    await h.say('hola');
    const second = await h.say('menú');
    expect(allText(second)).not.toContain('8968');
  });

  it('un primer mensaje sin sentido muestra el menú sin contarlo como fallo', async () => {
    const h = createHarness();
    const replies = await h.say('asdfgh');
    expect(allText(replies)).toContain('8968');
    expect(lastList(replies).rows).toHaveLength(5);
    expect(allText(replies)).not.toContain('no logré entender');
  });
});

describe('agendar: flujo feliz', () => {
  it('especialidad -> médico -> día -> hora -> nombre -> confirmar crea la cita', async () => {
    const h = createHarness();
    await h.say('hola');
    let replies = await h.pick('menu:agendar');
    expect(lastList(replies).rows.map((r) => r.id)).toContain('esp:cardiologia');

    replies = await h.pick('esp:cardiologia');
    expect(lastList(replies).rows.map((r) => r.id)).toEqual(['med:any', 'med:cardio-1', 'med:cardio-2']);

    replies = await h.pick('med:any');
    const day = lastList(replies).rows[0]!;
    expect(day.id).toMatch(/^dia:\d{4}-\d{2}-\d{2}$/);

    replies = await h.pick(day.id);
    const hour = lastList(replies).rows[0]!;
    replies = await h.pick(hour.id);
    expect(allText(replies)).toContain('nombre completo');

    replies = await h.say('Maria Prueba Rojas');
    const summary = lastButtons(replies);
    expect(summary.body).toContain('Maria Prueba Rojas');
    expect(summary.body).toContain('₡35 000');
    expect(summary.buttons.map((b) => b.title)).toEqual(['Confirmar', 'Cambiar', 'Cancelar']);

    replies = await h.pick('conf:si');
    expect(allText(replies)).toContain('reservada y pendiente de confirmación por recepción');
    const appointments = await h.agenda.listAppointments(PHONE);
    expect(appointments).toHaveLength(1);
    expect(appointments[0]).toMatchObject({ specialtyId: 'cardiologia', status: 'por_confirmar', patientName: 'Maria Prueba Rojas' });
  });

  it('en modo auto la cita se informa como confirmada', async () => {
    const h = createHarness({ confirmationMode: 'auto' });
    await bookUntilSummary(h);
    const replies = await h.pick('conf:si');
    expect(allText(replies)).toContain('confirmada');
    expect(allText(replies)).not.toContain('pendiente');
    expect((await h.agenda.listAppointments(PHONE))[0]!.status).toBe('confirmada');
  });

  it('se omite la pregunta del médico si la especialidad tiene uno solo', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    const replies = await h.pick('esp:dermatologia');
    expect(lastList(replies).rows[0]!.id).toMatch(/^dia:/);
  });

  it('con "cualquiera" las horas muestran qué médico atiende', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    await h.pick('esp:cardiologia');
    const days = await h.pick('med:any');
    const hours = await h.pick(lastList(days).rows[0]!.id);
    expect(lastList(hours).rows[0]!.description).toMatch(/^Dr/);
  });

  it('pide la cédula solo si pedirCedula es true', async () => {
    const h = createHarness({ clinic: clinicWith({ pedirCedula: true }) });
    await h.say('hola');
    await h.pick('menu:agendar');
    let replies = await h.pick('esp:dermatologia');
    replies = await h.pick(lastList(replies).rows[0]!.id);
    await h.pick(lastList(replies).rows[0]!.id);
    replies = await h.say('Maria Prueba Rojas');
    expect(allText(replies)).toContain('cédula');
    replies = await h.say('1-0234-0567');
    expect(lastButtons(replies).body).toContain('Maria Prueba Rojas');
  });

  it('valida el nombre y no acepta basura', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    let replies = await h.pick('esp:dermatologia');
    replies = await h.pick(lastList(replies).rows[0]!.id);
    await h.pick(lastList(replies).rows[0]!.id);
    replies = await h.say('x');
    expect(allText(replies)).toContain('nombre completo');
    replies = await h.say('Ana Mora');
    expect(lastButtons(replies).body).toContain('Ana Mora');
  });

  it('"Cambiar" reinicia desde la especialidad y "Cancelar" abandona', async () => {
    const h = createHarness();
    await bookUntilSummary(h);
    let replies = await h.pick('conf:cambiar');
    expect(lastList(replies).rows.map((r) => r.id)).toContain('esp:pediatria');

    await bookUntilSummary(h);
    replies = await h.pick('conf:cancelar');
    expect(allText(replies)).toContain('no se realizó ningún cambio');
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(0);
  });

  it('acepta "sí" escrito en la confirmación', async () => {
    const h = createHarness();
    await bookUntilSummary(h);
    await h.say('Sí');
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(1);
  });
});

describe('agendar: atajo por especialidad', () => {
  it('"quiero cita con cardiología" salta directo al médico', async () => {
    const h = createHarness();
    const replies = await h.say('quiero cita con cardiología');
    expect(allText(replies)).toContain('8968'); // primer contacto
    expect(lastList(replies).rows.map((r) => r.id)).toEqual(['med:any', 'med:cardio-1', 'med:cardio-2']);
  });

  it('con una especialidad de un solo médico salta directo a los días', async () => {
    const h = createHarness();
    await h.say('hola');
    const replies = await h.say('Necesito cita de dermatología');
    expect(lastList(replies).rows[0]!.id).toMatch(/^dia:/);
  });

  it('preguntar por una especialidad sin pedir cita muestra su detalle', async () => {
    const h = createHarness();
    await h.say('hola');
    const replies = await h.say('cuánto cuesta pediatría');
    expect(allText(replies)).toContain('₡28 000');
    expect(lastButtons(replies).buttons.map((b) => b.title)).toContain('Agendar');
  });
});

describe('agendar: espacio ocupado al confirmar', () => {
  it('se disculpa y ofrece otros horarios', async () => {
    const h = createHarness();
    const { date, time } = await bookUntilSummary(h, 'dermatologia');
    // Otra persona (p. ej. recepción desde Siku) ocupa ese espacio mientras el paciente confirma.
    h.agenda.block('derma-1', isoCR(date, time), new Date(Date.parse(isoCR(date, time)) + 20 * 60_000).toISOString());

    const replies = await h.pick('conf:si');
    expect(allText(replies)).toContain('acaba de ser ocupado');
    const hours = lastList(replies).rows;
    expect(hours.length).toBeGreaterThan(0);
    expect(hours.map((r) => r.id)).not.toContain(`hora:${time}`);
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(0);
  });
});

describe('agendar: horarios paginados', () => {
  it('con más de 9 horarios muestra 9 + "Ver más horarios" y recorre las páginas', async () => {
    // Domingo 15: el lunes 16 de dermatología tiene 21 espacios de 20 minutos.
    const h = createHarness({ now: new Date('2026-11-15T10:00:00-06:00') });
    await h.say('hola');
    await h.pick('menu:agendar');
    let replies = await h.pick('esp:dermatologia');
    const monday = lastList(replies).rows.find((r) => r.id === 'dia:2026-11-16')!;
    replies = await h.pick(monday.id);

    let rows = lastList(replies).rows;
    expect(rows).toHaveLength(10);
    expect(rows[9]).toMatchObject({ id: 'hora:mas', title: 'Ver más horarios' });
    const firstPage = rows.slice(0, 9).map((r) => r.id);

    replies = await h.pick('hora:mas');
    rows = lastList(replies).rows;
    expect(rows).toHaveLength(10);
    expect(rows.slice(0, 9).map((r) => r.id).some((id) => firstPage.includes(id))).toBe(false);

    replies = await h.pick('hora:mas');
    rows = lastList(replies).rows;
    expect(rows).toHaveLength(3); // 21 = 9 + 9 + 3, sin "Ver más" en la última página
    expect(rows.map((r) => r.id)).not.toContain('hora:mas');
  });

  it('con 9 horarios o menos no hay "Ver más"', async () => {
    const h = createHarness({ now: new Date('2026-11-15T10:00:00-06:00') });
    await h.say('hola');
    await h.pick('menu:agendar');
    let replies = await h.pick('esp:dermatologia');
    const tuesday = lastList(replies).rows.find((r) => r.id === 'dia:2026-11-17')!; // 09:00-12:00 = 9 bloques
    replies = await h.pick(tuesday.id);
    expect(lastList(replies).rows).toHaveLength(9);
  });

  it('los días también se paginan con "Ver más días"', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    let replies = await h.pick('esp:cardiologia');
    replies = await h.pick('med:any');
    const first = lastList(replies).rows;
    expect(first).toHaveLength(10);
    expect(first[9]!.id).toBe('dia:mas');
    replies = await h.pick('dia:mas');
    const second = lastList(replies).rows;
    expect(second.slice(0, 9).some((r) => first.some((f) => f.id === r.id))).toBe(false);
  });
});

describe('límite de citas activas por teléfono', () => {
  it('no deja agendar más del máximo configurado', async () => {
    const h = createHarness({ clinic: clinicWith({ maxCitasActivasPorTelefono: 1 }) });
    await bookUntilSummary(h);
    await h.pick('conf:si');
    await h.pick('menu:menu');
    const replies = await h.pick('menu:agendar');
    expect(allText(replies)).toContain('máximo permitido');
    expect(lastButtons(replies).buttons.map((b) => b.title)).toContain('Mis citas');
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(1);
  });

  it('por defecto el máximo es 2', async () => {
    const h = createHarness();
    for (let i = 0; i < 2; i++) {
      await bookUntilSummary(h, i === 0 ? 'dermatologia' : 'pediatria');
      await h.pick('conf:si');
    }
    const replies = await h.pick('menu:agendar');
    expect(allText(replies)).toContain('máximo permitido');
  });
});

describe('mis citas y cancelación', () => {
  it('lista las citas futuras y cancela con confirmación', async () => {
    const h = createHarness();
    await bookUntilSummary(h);
    await h.pick('conf:si');

    let replies = await h.say('quiero cancelar mi cita');
    const list = lastList(replies);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]!.description).toContain('Dermatología');

    replies = await h.pick(list.rows[0]!.id);
    expect(lastButtons(replies).buttons.map((b) => b.title)).toEqual(['Sí, cancelar cita', 'No, conservarla']);
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(1); // aún no se canceló

    replies = await h.pick('citas:si');
    expect(allText(replies)).toContain('cancelada');
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(0);
  });

  it('"No, conservarla" mantiene la cita', async () => {
    const h = createHarness();
    await bookUntilSummary(h);
    await h.pick('conf:si');
    const replies = await h.pick('menu:citas');
    await h.pick(lastList(replies).rows[0]!.id);
    const answer = await h.pick('citas:no');
    expect(allText(answer)).toContain('se mantiene');
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(1);
  });

  it('sin citas lo informa y ofrece agendar', async () => {
    const h = createHarness();
    await h.say('hola');
    const replies = await h.pick('menu:citas');
    expect(allText(replies)).toContain('No encontré citas');
    expect(lastButtons(replies).buttons.map((b) => b.title)).toContain('Agendar cita');
  });

  it('un teléfono no ve ni cancela citas de otro', async () => {
    const h = createHarness();
    await bookUntilSummary(h);
    await h.pick('conf:si');
    await h.say('hola', '50699998888');
    const replies = await h.pick('menu:citas', '50699998888');
    expect(allText(replies)).toContain('No encontré citas');
  });
});

describe('información', () => {
  it('horario y ubicación desde la configuración', async () => {
    const h = createHarness();
    await h.say('hola');
    const replies = await h.say('¿cuál es el horario?');
    const text = allText(replies);
    expect(text).toContain('Calle Ficticia 123');
    expect(text).toContain('SINPE Móvil');
    expect(text).toContain('maps.example.com');
  });

  it('especialidades y precios: lista, detalle y botón agendar', async () => {
    const h = createHarness();
    await h.say('hola');
    let replies = await h.pick('menu:servicios');
    expect(lastList(replies).rows.map((r) => r.title)).toContain('Cardiología');
    replies = await h.pick('esp:cardiologia');
    const text = allText(replies);
    expect(text).toContain('₡35 000');
    expect(text).toContain('30 minutos');
    expect(text).toContain('Dra. Alma Ejemplo');
    replies = await h.pick('serv:agendar');
    expect(lastList(replies).rows.map((r) => r.id)).toContain('med:any');
  });
});

describe('reglas globales', () => {
  it('urgencia: indica 9-1-1, pasa a recepción y pausa el bot', async () => {
    const h = createHarness();
    await h.say('hola');
    const replies = await h.say('mi papá tiene dolor de pecho y no puede respirar');
    const text = allText(replies);
    expect(text).toContain('no atiende emergencias');
    expect(text).toContain('9-1-1');
    expect(await h.pauses.isPaused(PHONE)).toBe(true);
    expect(await h.say('hola')).toEqual([]); // el bot calla mientras dura la pausa
  });

  it('la urgencia interrumpe un flujo en curso', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    const replies = await h.say('es una emergencia');
    expect(allText(replies)).toContain('9-1-1');
  });

  it('recepción: avisa y pausa; al terminar la pausa el bot retoma desde el menú', async () => {
    const h = createHarness();
    await h.say('hola');
    const replies = await h.say('quiero hablar con una persona');
    expect(allText(replies)).toContain('Recepción le atenderá por este mismo chat');
    expect(await h.say('gracias')).toEqual([]);
    h.advanceMinutes(121);
    const after = await h.say('hola');
    expect(lastList(after).rows).toHaveLength(5);
  });

  it('pregunta médica: no orienta, ofrece agendar o recepción', async () => {
    const h = createHarness();
    await h.say('hola');
    for (const q of ['¿Qué tomo para la fiebre?', 'qué tengo doctor', 'es grave?']) {
      const replies = await h.say(q);
      const text = allText(replies);
      expect(text).toContain('no puedo dar diagnósticos');
      expect(lastButtons(replies).buttons.map((b) => b.title)).toEqual(['Agendar cita', 'Hablar con recepción']);
    }
  });

  it('una petición de cita con síntoma no se bloquea (y no pregunta el motivo)', async () => {
    const h = createHarness();
    await h.say('hola');
    const replies = await h.say('tengo fiebre, quiero agendar una cita');
    expect(lastList(replies).rows.map((r) => r.id)).toContain('esp:cardiologia');
  });

  it('"menú" y "hola" vuelven al menú desde cualquier paso y descartan el flujo', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    await h.pick('esp:cardiologia');
    const replies = await h.say('Menú');
    expect(lastList(replies).rows).toHaveLength(5);
    // la siguiente respuesta ya no se interpreta como parte del flujo anterior
    const next = await h.pick('med:cardio-1');
    expect(allText(next)).toContain('no logré entender');
  });

  it('"salir" o "cancelar" dentro de un flujo lo abandonan', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    for (const word of ['salir', 'cancelar']) {
      const replies = await h.say(word);
      expect(allText(replies)).toContain('no se realizó ningún cambio');
      await h.pick('menu:agendar');
    }
  });

  it('tipos no soportados (audio, imagen...) piden usar texto', async () => {
    const h = createHarness();
    await h.say('hola');
    const replies = await h.send({ type: 'unsupported', kind: 'audio' });
    expect(allText(replies)).toContain('solo puedo atender mensajes de texto');
    expect(lastButtons(replies).buttons.map((b) => b.title)).toEqual(['Ver menú', 'Hablar con recepción']);
  });
});

describe('mensajes no entendidos', () => {
  it('primer fallo: repregunta con opciones; segundo consecutivo: ofrece recepción', async () => {
    const h = createHarness();
    await h.say('hola');
    let replies = await h.say('blablabla');
    expect(allText(replies)).toContain('no logré entender');
    expect(lastList(replies).rows).toHaveLength(5);

    replies = await h.say('qwerty');
    expect(lastButtons(replies).buttons.map((b) => b.title)).toEqual(['Hablar con recepción', 'Ver menú']);

    replies = await h.pick('menu:recepcion');
    expect(allText(replies)).toContain('Recepción le atenderá');
    expect(await h.pauses.isPaused(PHONE)).toBe(true);
  });

  it('un acierto entre dos fallos reinicia la cuenta', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.say('blablabla');
    await h.say('horario');
    const replies = await h.say('blablabla');
    expect(allText(replies)).toContain('no logré entender'); // otra vez el primer fallo, no la oferta
  });

  it('también cuenta dentro de un flujo', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    let replies = await h.say('mmm');
    expect(lastList(replies).rows.map((r) => r.id)).toContain('esp:cardiologia');
    replies = await h.say('eh');
    expect(lastButtons(replies).buttons[0]!.title).toBe('Hablar con recepción');
  });
});

describe('sesiones', () => {
  it('expiran tras 30 minutos de inactividad: se empieza de cero con saludo', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    await h.pick('esp:cardiologia');

    h.advanceMinutes(31);
    const replies = await h.pick('med:any'); // respuesta a una pregunta de la sesión vencida
    expect(allText(replies)).toContain('8968'); // saludo de nueva sesión
    expect(lastList(replies).rows).toHaveLength(5); // menú, no continuación del flujo
  });

  it('no expiran si hay actividad dentro del plazo', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    h.advanceMinutes(20);
    await h.pick('esp:cardiologia');
    h.advanceMinutes(20); // 40 min en total, pero solo 20 desde el último mensaje
    const replies = await h.pick('med:any');
    expect(lastList(replies).rows[0]!.id).toMatch(/^dia:/);
  });
});

describe('robustez', () => {
  it('si la agenda falla, el paciente recibe una disculpa y la oferta de recepción', async () => {
    const h = createHarness();
    await h.say('hola');
    h.agenda.getAvailableSlots = async () => {
      throw new Error('fallo simulado');
    };
    await h.pick('menu:agendar');
    const replies = await h.pick('esp:dermatologia');
    expect(allText(replies)).toContain('inconveniente');
    expect(lastButtons(replies).buttons.map((b) => b.title)).toContain('Hablar con recepción');
    // y la conversación sigue viva
    expect(lastList(await h.say('menú')).rows).toHaveLength(5);
  });

  it('no hay disponibilidad: lo dice y ofrece recepción', async () => {
    const h = createHarness({ clinic: clinicWith({ diasMaxAdelanto: 1, feriados: ['2026-11-16', '2026-11-17'] }) });
    await h.say('hola');
    await h.pick('menu:agendar');
    const replies = await h.pick('esp:pediatria');
    expect(allText(replies)).toContain('no hay espacios disponibles');
  });

  it('el límite de tasa descarta mensajes de un teléfono abusivo', async () => {
    const { RateLimiter } = await import('../src/util/rateLimit.js');
    const limiter = new RateLimiter(3, 60_000, () => 0);
    expect([1, 2, 3, 4].map(() => limiter.allow('a'))).toEqual([true, true, true, false]);
    expect(limiter.allow('b')).toBe(true);
  });
});
