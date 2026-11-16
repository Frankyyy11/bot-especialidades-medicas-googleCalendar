import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider, PENDING_PREFIX } from '../src/agenda/googleCalendar.js';
import { AgendaError, AppointmentNotFoundError, SlotTakenError } from '../src/agenda/provider.js';
import { loadClinic } from '../src/config/clinic.js';

const clinic = loadClinic('config/centro.json');
const DERMA_CAL = 'REEMPLAZAR-derma-1@group.calendar.google.com';
const NOW = new Date('2026-11-16T07:00:00-06:00'); // lunes 7:00
const PHONE = '50688881234';

interface Call {
  method: string;
  url: URL;
  body: any;
  headers: Record<string, string>;
}

/** fetch simulado: enruta por método y ruta; registra cada llamada. No toca la red. */
function mockGoogle(handlers: {
  busy?: Array<{ start: string; end: string }>;
  insert?: (body: any) => Response;
  list?: unknown[];
  event?: unknown | null;
  freeBusyStatuses?: number[];
}) {
  const calls: Call[] = [];
  const statuses = [...(handlers.freeBusyStatuses ?? [])];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  const fetchFn = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);

    if (url.pathname.endsWith('/freeBusy')) {
      const forced = statuses.shift();
      if (forced) return json({ error: 'x' }, forced);
      return json({ calendars: { [call.body.items[0].id]: { busy: handlers.busy ?? [] } } });
    }
    if (call.method === 'POST' && url.pathname.endsWith('/events')) {
      return handlers.insert ? handlers.insert(call.body) : json({ id: 'ev123', ...call.body });
    }
    if (call.method === 'GET' && url.pathname.endsWith('/events')) return json({ items: handlers.list ?? [] });
    if (call.method === 'GET' && url.pathname.includes('/events/')) {
      return handlers.event === null ? json({}, 404) : json(handlers.event ?? {});
    }
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    return json({}, 500);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function provider(fetchFn: typeof fetch, mode: 'recepcion' | 'auto' = 'recepcion') {
  return new GoogleCalendarProvider({
    clinic,
    fetchFn,
    getAccessToken: async () => 'token-falso',
    now: () => NOW,
    confirmationMode: mode,
    retryDelayMs: 0,
  });
}

describe('GoogleCalendarProvider.getAvailableSlots', () => {
  it('parte el horario y descarta lo que devuelve freeBusy', async () => {
    const { fetchFn, calls } = mockGoogle({ busy: [{ start: '2026-11-16T09:00:00-06:00', end: '2026-11-16T09:40:00-06:00' }] });
    const slots = await provider(fetchFn).getAvailableSlots('derma-1', '2026-11-16'); // lunes 09-12, 13-17; bloques de 20 min

    const times = slots.map((s) => s.time);
    expect(times).not.toContain('09:00'); // 09:00-09:20 traslapa
    expect(times).not.toContain('09:20'); // 09:20-09:40 traslapa
    expect(times).toContain('09:40');
    expect(times).toContain('13:00');
    expect(times).not.toContain('12:00'); // fuera de los rangos de atención

    // Una sola consulta freeBusy, con la ventana del día en hora de Costa Rica y el calendario del médico.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/calendar/v3/freeBusy');
    expect(calls[0]!.body).toMatchObject({
      timeMin: '2026-11-16T00:00:00-06:00',
      timeMax: '2026-11-17T00:00:00-06:00',
      timeZone: 'America/Costa_Rica',
      items: [{ id: DERMA_CAL }],
    });
    expect(calls[0]!.headers.Authorization).toBe('Bearer token-falso');
  });

  it('aplica anticipación mínima (2 h) con la hora actual', async () => {
    const { fetchFn } = mockGoogle({});
    const slots = await provider(fetchFn).getAvailableSlots('derma-1', '2026-11-16');
    expect(slots[0]!.time).toBe('09:00'); // 07:00 + 2 h = 09:00
  });

  it('no consulta a Google si el médico no atiende ese día o es feriado', async () => {
    const { fetchFn, calls } = mockGoogle({});
    const p = provider(fetchFn);
    expect(await p.getAvailableSlots('derma-1', '2026-11-18')).toEqual([]); // miércoles: no atiende
    expect(await p.getAvailableSlots('derma-1', '2026-12-25')).toEqual([]); // feriado
    expect(calls).toHaveLength(0);
  });

  it('falla con claridad si Google devuelve errores para el calendario', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ calendars: { [DERMA_CAL]: { errors: [{ reason: 'notFound' }] } } }), { status: 200 }));
    await expect(provider(fetchFn as unknown as typeof fetch).getAvailableSlots('derma-1', '2026-11-16')).rejects.toBeInstanceOf(AgendaError);
  });
});

describe('GoogleCalendarProvider.createAppointment', () => {
  const input = { doctorId: 'derma-1', specialtyId: 'dermatologia', start: '2026-11-16T10:00:00-06:00', patientName: 'Maria Prueba Rojas', phone: PHONE };

  it('crea el evento con título [POR CONFIRMAR], descripción y propiedades privadas', async () => {
    const { fetchFn, calls } = mockGoogle({});
    const appt = await provider(fetchFn).createAppointment({ ...input, cedula: '102340567' });

    const insert = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/events'))!;
    expect(insert.url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(DERMA_CAL)}/events`);
    expect(insert.body.summary).toBe(`${PENDING_PREFIX}Dermatología – Maria Prueba Rojas`);
    expect(insert.body.description).toContain('Maria Prueba Rojas');
    expect(insert.body.description).toContain(PHONE);
    expect(insert.body.description).toContain('102340567');
    expect(insert.body.start).toEqual({ dateTime: '2026-11-16T10:00:00-06:00', timeZone: 'America/Costa_Rica' });
    expect(insert.body.end.dateTime).toBe('2026-11-16T10:20:00-06:00');
    expect(insert.body.extendedProperties.private).toEqual({
      phone: PHONE,
      doctorId: 'derma-1',
      specialtyId: 'dermatologia',
      source: 'bot',
    });
    expect(appt).toMatchObject({ id: 'derma-1:ev123', status: 'por_confirmar', date: '2026-11-16', time: '10:00' });
  });

  it('verifica la disponibilidad (freeBusy) justo antes de insertar', async () => {
    const { fetchFn, calls } = mockGoogle({});
    await provider(fetchFn).createAppointment(input);
    const order = calls.map((c) => `${c.method} ${c.url.pathname.split('/').pop()}`);
    expect(order).toEqual(['POST freeBusy', 'POST events']);
  });

  it('lanza SlotTakenError si el espacio ya está ocupado, sin crear nada', async () => {
    const { fetchFn, calls } = mockGoogle({ busy: [{ start: '2026-11-16T10:00:00-06:00', end: '2026-11-16T10:20:00-06:00' }] });
    await expect(provider(fetchFn).createAppointment(input)).rejects.toBeInstanceOf(SlotTakenError);
    expect(calls.some((c) => c.url.pathname.endsWith('/events'))).toBe(false);
  });

  it('modo auto: sin prefijo y estado confirmada', async () => {
    const { fetchFn, calls } = mockGoogle({});
    const appt = await provider(fetchFn, 'auto').createAppointment(input);
    expect(calls.find((c) => c.url.pathname.endsWith('/events'))!.body.summary).toBe('Dermatología – Maria Prueba Rojas');
    expect(appt.status).toBe('confirmada');
  });
});

describe('GoogleCalendarProvider.listAppointments', () => {
  it('busca por propiedad privada phone en cada calendario y devuelve solo futuras, ordenadas', async () => {
    const { fetchFn, calls } = mockGoogle({
      list: [
        {
          id: 'e2',
          summary: `${PENDING_PREFIX}Dermatología – Maria`,
          description: 'Paciente: Maria Prueba Rojas',
          start: { dateTime: '2026-11-20T10:00:00-06:00' },
          end: { dateTime: '2026-11-20T10:20:00-06:00' },
          extendedProperties: { private: { phone: PHONE, doctorId: 'derma-1', specialtyId: 'dermatologia', source: 'bot' } },
        },
      ],
    });
    const list = await provider(fetchFn).listAppointments(PHONE);

    const requests = calls.filter((c) => c.method === 'GET');
    expect(requests).toHaveLength(5); // un calendario por médico
    expect(requests[0]!.url.searchParams.get('privateExtendedProperty')).toBe(`phone=${PHONE}`);
    expect(requests[0]!.url.searchParams.get('timeMin')).toBe(NOW.toISOString()); // solo futuras
    expect(list[0]).toMatchObject({ date: '2026-11-20', time: '10:00', status: 'por_confirmar', patientName: 'Maria Prueba Rojas', specialtyId: 'dermatologia' });
  });
});

describe('GoogleCalendarProvider.cancelAppointment', () => {
  it('borra el evento si el teléfono coincide', async () => {
    const { fetchFn, calls } = mockGoogle({ event: { id: 'ev9', extendedProperties: { private: { phone: PHONE } } } });
    await provider(fetchFn).cancelAppointment('derma-1:ev9', PHONE);
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(DERMA_CAL)}/events/ev9`);
  });

  it('no borra si el teléfono no coincide', async () => {
    const { fetchFn, calls } = mockGoogle({ event: { id: 'ev9', extendedProperties: { private: { phone: '50600000000' } } } });
    await expect(provider(fetchFn).cancelAppointment('derma-1:ev9', PHONE)).rejects.toBeInstanceOf(AppointmentNotFoundError);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('evento inexistente o id mal formado: AppointmentNotFoundError', async () => {
    const { fetchFn } = mockGoogle({ event: null });
    await expect(provider(fetchFn).cancelAppointment('derma-1:nada', PHONE)).rejects.toBeInstanceOf(AppointmentNotFoundError);
    await expect(provider(fetchFn).cancelAppointment('sin-separador', PHONE)).rejects.toBeInstanceOf(AppointmentNotFoundError);
    await expect(provider(fetchFn).cancelAppointment('medico-falso:ev', PHONE)).rejects.toBeInstanceOf(AppointmentNotFoundError);
  });
});

describe('reintentos y errores de la API', () => {
  it('reintenta una vez ante un 500 y se recupera', async () => {
    const { fetchFn, calls } = mockGoogle({ freeBusyStatuses: [500] });
    const slots = await provider(fetchFn).getAvailableSlots('derma-1', '2026-11-16');
    expect(slots.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
  });

  it('si el segundo intento también falla, lanza el error (no más reintentos)', async () => {
    const { fetchFn, calls } = mockGoogle({ freeBusyStatuses: [503, 503, 503] });
    await expect(provider(fetchFn).getAvailableSlots('derma-1', '2026-11-16')).rejects.toBeInstanceOf(AgendaError);
    expect(calls).toHaveLength(2);
  });

  it('un error de red también se reintenta una vez', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ calendars: { [DERMA_CAL]: { busy: [] } } }), { status: 200 });
    });
    const slots = await provider(fetchFn as unknown as typeof fetch).getAvailableSlots('derma-1', '2026-11-16');
    expect(slots.length).toBeGreaterThan(0);
    expect(n).toBe(2);
  });

  it('un 403 (sin permisos) no se reintenta', async () => {
    const { fetchFn, calls } = mockGoogle({ freeBusyStatuses: [403] });
    await expect(provider(fetchFn).getAvailableSlots('derma-1', '2026-11-16')).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });
});
