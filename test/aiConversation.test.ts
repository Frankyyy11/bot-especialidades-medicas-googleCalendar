// Conversación natural con la IA activa: lo que el centro no ofrece, respuestas a mitad de un paso sin
// repetir la lista, y el conteo de fallos. Todo con IA simulada, sin red.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeAiProvider, ScriptedAiProvider } from '../src/ai/fake.js';
import { validateInterpretation } from '../src/ai/guards.js';
import type { AiInput } from '../src/ai/provider.js';
import { M } from '../src/engine/messages.js';
import { fitOutgoing } from '../src/whatsapp/limits.js';
import { allText, bookUntilSummary, createHarness, lastButtons, lastList, PHONE, textOf } from './helpers.js';

const ALL_SPECIALTIES = 'Cardiología, Dermatología, Pediatría y Ginecología';

function scripted(script: (input: AiInput) => unknown) {
  const ai = new ScriptedAiProvider(script);
  return { ai, h: createHarness({ ai }) };
}

async function state(h: ReturnType<typeof createHarness>) {
  return (await h.sessions.get(PHONE))!;
}

/** Deja la conversación en AGENDAR_DIA (cardiología, Dr. Bruno Prueba). */
async function untilDay(h: ReturnType<typeof createHarness>) {
  await h.say('hola');
  await h.pick('menu:agendar');
  await h.pick('esp:cardiologia');
  await h.pick('med:cardio-2');
  expect((await state(h)).state).toBe('AGENDAR_DIA');
}

describe('IA: lo que el centro no ofrece', () => {
  it('"Odontologia no tiene?" al elegir especialidad: dice que no y menciona lo que sí hay, sin repetir la lista', async () => {
    const h = createHarness({ ai: new FakeAiProvider() });
    await h.say('hola');
    await h.say('quiero una cita');
    expect((await state(h)).state).toBe('AGENDAR_ESPECIALIDAD');

    const replies = await h.say('Odontologia no tiene?');
    expect(replies.map((r) => r.type)).toEqual(['buttons']); // un solo mensaje, sin la lista completa
    const text = allText(replies);
    expect(text).toContain('no contamos con esa especialidad');
    expect(text).toContain(ALL_SPECIALTIES);
    expect(text).not.toMatch(/entendido|entender|odontolog/i); // ni suena a error ni repite palabras ajenas a la config
    expect(lastButtons(replies).buttons.map((b) => b.id)).toEqual(['cont:paso', 'menu:menu']);
    expect(await state(h)).toMatchObject({ state: 'AGENDAR_ESPECIALIDAD', failures: 0 });

    // El botón retoma el paso y escribir la especialidad sigue funcionando.
    const again = await h.pick('cont:paso');
    expect(lastList(again).body).toContain('¿Para cuál especialidad');
    await h.say('cardiología');
    expect((await state(h)).booking.especialidadId).toBe('cardiologia');
  });

  it('en el menú principal: mismo texto base y botones para ver especialidades o agendar', async () => {
    const h = createHarness({ ai: new FakeAiProvider() });
    await h.say('hola');
    const replies = await h.say('¿tienen psicología?');
    expect(allText(replies)).toContain(`no contamos con esa especialidad. Sí ofrecemos: ${ALL_SPECIALTIES}.`);
    expect(lastButtons(replies).buttons.map((b) => b.id)).toEqual(['menu:servicios', 'menu:agendar']);
    expect(await state(h)).toMatchObject({ state: 'MENU', failures: 0 });
  });

  it('pedir cita de algo que no hay tampoco inicia una reserva', async () => {
    const h = createHarness({ ai: new FakeAiProvider() });
    await h.say('hola');
    await h.pick('menu:servicios');
    const replies = await h.say('ocupo sacar cita con el dentista');
    expect(allText(replies)).toContain('no contamos con esa especialidad');
    expect((await state(h)).state).toBe('SERVICIOS_LISTA');
  });

  it('médico que no existe: lo dice y nombra a los médicos reales de la especialidad en curso', async () => {
    const h = createHarness({ ai: new FakeAiProvider() });
    await h.say('hola');
    await h.pick('menu:agendar');
    await h.pick('esp:cardiologia');
    const replies = await h.say('y el doctor Ramírez no atiende?');
    const text = allText(replies);
    expect(text).toContain('No encontré a ese médico');
    expect(text).toContain('En Cardiología atienden: Dra. Alma Ejemplo y Dr. Bruno Prueba.');
    expect(text).not.toMatch(/ram[ií]rez/i);
    expect(lastButtons(replies).buttons[0]).toEqual({ id: 'cont:paso', title: 'Ver médicos' });
    expect((await state(h)).state).toBe('AGENDAR_MEDICO');
  });

  it('servicio que no existe', async () => {
    const h = createHarness({ ai: new FakeAiProvider() });
    await h.say('hola');
    const replies = await h.say('¿hacen exámenes de sangre?');
    expect(allText(replies)).toContain(`no ofrecemos ese servicio. Contamos con consulta en: ${ALL_SPECIALTIES}.`);
  });

  it('la IA no puede negar algo que SÍ está en la configuración', async () => {
    // Modelo equivocado: marca "no disponible" aunque el paciente nombró una especialidad y un médico reales.
    const { h } = scripted(() => ({ intent: 'otro', noDisponible: 'especialidad', respuestaBreve: 'No tenemos esa especialidad.' }));
    await untilDay(h);
    const replies = await h.say('ustedes cardiología no tienen verdad');
    expect(allText(replies)).not.toContain('no contamos con');

    const { h: h2 } = scripted(() => ({ intent: 'otro', noDisponible: 'medico' }));
    await untilDay(h2);
    const r2 = await h2.say('la doctora Alma no trabaja ahí verdad');
    expect(allText(r2)).not.toContain('No encontré a ese médico');
  });

  it('validación: valores fuera del enum o contradictorios con un id válido se descartan', () => {
    const ctx = { clinic: createHarness().clinic, today: '2026-11-16' };
    expect(validateInterpretation({ intent: 'otro', noDisponible: 'gratis hoy' }, ctx)).toEqual({ intent: 'otro' });
    expect(validateInterpretation({ intent: 'otro', noDisponible: 'especialidad', especialidadId: 'cardiologia' }, ctx)).toEqual({
      intent: 'otro',
      especialidadId: 'cardiologia',
    });
    expect(validateInterpretation({ intent: 'otro', noDisponible: 'servicio' }, ctx)).toEqual({ intent: 'otro', noDisponible: 'servicio' });
  });

  it('la frase de la IA no acompaña al texto de "no se ofrece"', async () => {
    const { h } = scripted(() => ({ intent: 'otro', noDisponible: 'especialidad', respuestaBreve: 'Con gusto le cuento.' }));
    await h.say('hola');
    const replies = await h.say('y para la vista hay algo');
    expect(replies).toHaveLength(1);
    expect(allText(replies)).not.toContain('Con gusto le cuento');
  });

  it('con muchas especialidades el mensaje sigue dentro de los límites de WhatsApp', () => {
    const base = createHarness().clinic;
    const first = base.especialidades[0]!;
    const clinic = {
      ...base,
      especialidades: Array.from({ length: 80 }, (_, i) => ({ ...first, id: `esp-${i}`, nombre: `Especialidad larga ${i}` })),
    };
    for (const kind of ['especialidad', 'medico', 'servicio'] as const) {
      const message = M.notOffered({ clinic, kind, state: 'AGENDAR_ESPECIALIDAD' });
      expect(fitOutgoing(message)).toEqual(message);
      expect(textOf(message)).toContain('entre otras opciones');
    }
  });
});

describe('IA: conversación a mitad de un paso', () => {
  it('pregunta general: contesta y ofrece continuar con un botón, sin repetir la lista ni perder lo avanzado', async () => {
    const h = createHarness({ ai: new FakeAiProvider() });
    await untilDay(h);
    const replies = await h.say('¿tienen parqueo para los pacientes?');
    expect(replies.map((r) => r.type)).toEqual(['text', 'buttons']);
    expect(textOf(replies[0]!)).toContain('recepción con gusto le ayuda');
    expect(lastButtons(replies).buttons[0]).toEqual({ id: 'cont:paso', title: 'Ver días' });
    expect(allText(replies)).not.toMatch(/entendido|entender/);
    expect(await state(h)).toMatchObject({ state: 'AGENDAR_DIA', failures: 0, booking: { especialidadId: 'cardiologia', medicoId: 'cardio-2' } });

    const days = await h.pick('cont:paso');
    expect(lastList(days).rows[0]!.id).toMatch(/^dia:/);
  });

  it('formas de pago a mitad de la reserva: muestra los datos del centro y no reinicia el flujo', async () => {
    const h = createHarness({ ai: new FakeAiProvider() });
    await untilDay(h);
    const replies = await h.say('¿puedo pagar con tarjeta?');
    expect(textOf(replies[0]!)).toBe('Aceptamos: Efectivo, Tarjeta de crédito o débito, SINPE Móvil.');
    expect(allText(replies)).toContain('*Horario de atención:*');
    expect(lastButtons(replies).buttons[0]!.id).toBe('cont:paso');
    expect((await state(h)).state).toBe('AGENDAR_DIA');
  });

  it('agradecimiento y saludo con texto dentro de un flujo (proveedor simulado)', async () => {
    const h = createHarness({ ai: new FakeAiProvider() });
    await untilDay(h);
    const thanks = await h.say('ok, muchas gracias');
    expect(thanks.map((r) => r.type)).toEqual(['text', 'buttons']);
    expect(textOf(thanks[0]!)).toBe('Con mucho gusto, para eso estamos.');
    const hello = await h.say('hola, disculpe la molestia');
    expect(textOf(hello[0]!)).toBe('¡Hola! Con mucho gusto le ayudo.');
    expect(lastButtons(hello).buttons[0]!.title).toBe('Ver días');
    expect(await state(h)).toMatchObject({ state: 'AGENDAR_DIA', failures: 0 });
  });

  it('agradecimiento sin frase de la IA: se usa el texto base de messages.ts', async () => {
    const { h } = scripted(() => ({ intent: 'agradecimiento' }));
    await untilDay(h);
    const replies = await h.say('se lo agradezco un montón');
    expect(replies.map(textOf)[0]).toBe('Con mucho gusto.');
    expect(lastButtons(replies).buttons[0]!.id).toBe('cont:paso');
  });

  it('"hola" solo dentro de un flujo sigue reiniciando al menú (regla, sin IA)', async () => {
    const { ai, h } = scripted(() => ({ intent: 'saludo', respuestaBreve: 'Con gusto.' }));
    await untilDay(h);
    await h.say('hola');
    expect((await state(h)).state).toBe('MENU');
    expect(ai.calls).toHaveLength(0);
  });

  it('en la confirmación, "confirmar" de la IA con frase válida no confirma ni acompaña al resumen', async () => {
    const { h } = scripted(() => ({ intent: 'confirmar', respuestaBreve: 'Con gusto, perfecto.' }));
    await bookUntilSummary(h);
    const replies = await h.say('mmm bueno, está bien así');
    expect(allText(replies)).not.toContain('Con gusto, perfecto');
    expect(lastButtons(replies).buttons.map((b) => b.title)).toContain('Confirmar');
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(0);
  });

  it('pregunta general en la confirmación: la frase va con el botón "Ver resumen", no con el resumen', async () => {
    const { h } = scripted(() => ({ intent: 'otro', respuestaBreve: 'Con gusto; recepción le puede ayudar con esa consulta.' }));
    await bookUntilSummary(h);
    const replies = await h.say('una pregunta, ¿hay que llegar antes?');
    expect(replies.map((r) => r.type)).toEqual(['text', 'buttons']);
    expect(allText(replies)).toContain('todavía no ha sido registrada');
    expect(allText(replies)).not.toContain('Precio de la consulta');
    const summary = await h.pick('cont:paso');
    expect(lastButtons(summary).buttons.map((b) => b.id)).toContain('conf:si');
    expect(await h.agenda.listAppointments(PHONE)).toHaveLength(0);
  });
});

describe('IA: conteo de fallos', () => {
  it('una respuesta conversacional válida no cuenta como fallo; dos fallos reales seguidos sí ofrecen recepción', async () => {
    let brief: string | undefined;
    const { h } = scripted(() => ({ intent: 'otro', ...(brief ? { respuestaBreve: brief } : {}) }));
    await untilDay(h);

    const first = await h.say('asdf qwer zxcv'); // la IA no devuelve nada útil: primer fallo
    expect(allText(first)).toContain('no estoy seguro de haberle entendido');
    expect((await state(h)).failures).toBe(1);

    brief = 'Con gusto; recepción le puede ayudar con esa consulta.';
    const chat = await h.say('una pregunta rara'); // respuesta conversacional: reinicia el conteo
    expect(allText(chat)).not.toContain('entendido');
    expect((await state(h)).failures).toBe(0);

    brief = undefined;
    const second = await h.say('asdf qwer zxcv');
    expect(allText(second)).toContain('no estoy seguro de haberle entendido'); // otra vez el primer fallo
    const third = await h.say('asdf qwer zxcv');
    expect(allText(third)).toContain('¿Desea que le atienda una persona de recepción?');
  });

  it('frase de la IA que no pasa las guardas: cuenta como no entendido', async () => {
    const { h } = scripted(() => ({ intent: 'otro', respuestaBreve: 'Claro, la consulta es gratis.' }));
    await untilDay(h);
    const replies = await h.say('una pregunta rara');
    expect(allText(replies)).toContain('no estoy seguro de haberle entendido');
    expect(allText(replies)).not.toContain('gratis');
    expect((await state(h)).failures).toBe(1);
  });

  it('IA apagada: "no entendido" amable con la lista del paso, como siempre', async () => {
    const h = createHarness();
    await h.say('hola');
    await h.pick('menu:agendar');
    const replies = await h.say('Odontologia no tiene?');
    expect(textOf(replies[0]!)).toBe('Disculpe, no estoy seguro de haberle entendido. ¿Me ayuda eligiendo una de estas opciones?');
    expect(lastList(replies).body).toContain('¿Para cuál especialidad');
  });

  it('en nombre y cédula la IA sigue sin llamarse', async () => {
    const { ai, h } = scripted(() => ({ intent: 'otro', noDisponible: 'especialidad' }));
    await untilDay(h);
    let r = await h.pick('cont:paso');
    r = await h.pick(lastList(r).rows[0]!.id);
    await h.pick(lastList(r).rows[0]!.id);
    expect((await state(h)).state).toBe('AGENDAR_NOMBRE');
    await h.say('Odontologia no tiene?'); // aquí es un nombre inválido, no una consulta a la IA
    expect(ai.calls).toHaveLength(0);
  });
});

describe('proveedor simulado', () => {
  const clinic = createHarness().clinic;
  const ask = (text: string) => new FakeAiProvider().interpret({ text, history: [], clinic, today: '2026-11-16', weekday: 'lunes', state: 'AGENDAR_ESPECIALIDAD' });

  it('señala lo que el centro no tiene, y no lo que sí tiene', async () => {
    expect(await ask('Odontologia no tiene?')).toEqual({ intent: 'otro', noDisponible: 'especialidad' });
    expect(await ask('quiero cita con el oftalmólogo')).toEqual({ intent: 'agendar', noDisponible: 'especialidad' });
    expect(await ask('atiende el dr Ramírez?')).toMatchObject({ noDisponible: 'medico' });
    expect(await ask('tienen laboratorio?')).toMatchObject({ noDisponible: 'servicio' });
    expect((await ask('cardiología no tiene?'))?.noDisponible).toBeUndefined();
    expect((await ask('atiende la dra Alma?'))?.noDisponible).toBeUndefined();
  });
});

describe('simulador: diálogo de odontología (guion de test/fixtures)', () => {
  const run = (provider: string, input: string) =>
    execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/chat.ts'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, AI_PROVIDER: provider, CHAT_NOW: '2026-11-16T10:00:00-06:00', LOG_LEVEL: 'error' },
      timeout: 30_000,
    });

  it('con IA simulada conversa sin "no entendido"', () => {
    const output = run('fake', readFileSync('test/fixtures/ia-conversacion.txt', 'utf8'));
    expect(output).toContain(`no contamos con esa especialidad. Sí ofrecemos: ${ALL_SPECIALTIES}.`);
    expect(output).toContain('Con mucho gusto, para eso estamos.');
    expect(output).toContain('En Cardiología atienden: Dra. Alma Ejemplo y Dr. Bruno Prueba.');
    expect(output).not.toContain('no estoy seguro de haberle entendido');
    expect(output).not.toContain('AVISO');
  });

  it('con AI_PROVIDER=none avisa al arrancar que la IA está apagada', () => {
    const output = run('none', 'hola\n/salir\n');
    expect(output).toContain('AVISO: la IA está apagada');
    expect(output).toContain('$env:AI_PROVIDER="fake"; npm run chat');
  });
});
