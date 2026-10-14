import { describe, it, expect, vi } from 'vitest';
import { PowerRepository, parsePowerApiResponse } from '../src/data/power-repository.js';

const INDEX = {
  data_version: 1,
  locations: [
    {
      id: 'iquitos',
      name: 'Iquitos (selva amazonica, Peru)',
      path: 'power/iquitos.json',
      coords_requested: { lat: -3.75, lon: -73.25 }
    },
    {
      id: 'mar-piura',
      name: 'Oceano frente a Piura, Peru',
      path: 'power/mar-piura.json',
      coords_requested: { lat: -5.0, lon: -81.5 }
    }
  ]
};

function localJsonFor(id) {
  return {
    data_version: 1,
    location_id: id,
    units: 'mm/day',
    coords_effective: { lat: -3.75, lon: -73.25, elevation_m: 115 },
    source: { service_name: 'NASA POWER' },
    period_start: '2000-01',
    period_end: '2025-12',
    monthly: { '2023-01': 12.14 }
  };
}

function liveJsonOk(overrides = {}) {
  return {
    header: { fill_value: -999, sources: ['MERRA2'], api: { version: 'v2.10.0' } },
    parameters: { PRECTOTCORR: { units: 'mm/day' } },
    geometry: { coordinates: [-73.25, -3.75, 115] },
    properties: { parameter: { PRECTOTCORR: { '202301': 5, '202313': -999 } } },
    ...overrides
  };
}

function fetchImplFor({ index = INDEX, local = localJsonFor('iquitos'), live = liveJsonOk() } = {}) {
  return vi.fn(async (url) => {
    if (String(url).includes('power-index.json')) {
      return { ok: true, json: async () => index };
    }
    if (String(url).includes('power/')) {
      return { ok: true, json: async () => local };
    }
    return { ok: true, json: async () => live };
  });
}

describe('PowerRepository: coincidencia de puntos locales', () => {
  it('coincide con Iquitos por coordenadas exactas y usa el JSON local correcto', async () => {
    const fetchImpl = fetchImplFor();
    const repo = new PowerRepository({ fetchImpl, baseUrl: '/data/' });
    const result = await repo.getMonthlyForPoint(-3.75, -73.25);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('local');
    expect(result.locationId).toBe('iquitos');
    expect(result.dataVersion).toBe(1);
  });

  it('NO atribuye el dato de Iquitos a un punto cercano pero distinto (el epsilon es minimo, no un radio)', async () => {
    const fetchImpl = fetchImplFor();
    const repo = new PowerRepository({ fetchImpl, baseUrl: '/data/' });
    // 0.01 grados (~1km) de diferencia: con el epsilon amplio anterior
    // (0.05) esto habria coincidido erroneamente con Iquitos.
    const result = await repo.getMonthlyForPoint(-3.76, -73.25, { year: 2023 });
    expect(result.source).not.toBe('local');
  });

  it('un punto sin anio y sin coincidencia local devuelve error explicito (no inventa dato)', async () => {
    const fetchImpl = fetchImplFor();
    const repo = new PowerRepository({ fetchImpl, baseUrl: '/data/' });
    const result = await repo.getMonthlyForPoint(10, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid-year');
  });

  it('rechaza coordenadas fuera de rango en vez de aceptarlas', async () => {
    const repo = new PowerRepository({ fetchImpl: fetchImplFor(), baseUrl: '/data/' });
    expect((await repo.getMonthlyForPoint(200, 0, { year: 2023 })).error).toBe('invalid-coords');
    expect((await repo.getMonthlyForPoint(0, 400, { year: 2023 })).error).toBe('invalid-coords');
  });

  it('rechaza un anio no finito/fuera de rango razonable', async () => {
    const repo = new PowerRepository({ fetchImpl: fetchImplFor(), baseUrl: '/data/' });
    expect((await repo.getMonthlyForPoint(10, 10, { year: 1900 })).error).toBe('invalid-year');
  });

  it('elegir un punto local cancela una consulta en vivo pendiente de otro punto', async () => {
    let liveSignal;
    const fetchImpl = vi.fn(async (url, opts) => {
      if (String(url).includes('power-index.json')) return { ok: true, json: async () => INDEX };
      if (String(url).includes('power/')) return { ok: true, json: async () => localJsonFor('iquitos') };
      liveSignal = opts?.signal;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, json: async () => liveJsonOk() };
    });
    const repo = new PowerRepository({ fetchImpl, baseUrl: '/data/' });
    const livePromise = repo.getMonthlyForPoint(10, 10, { year: 2023 });
    await Promise.resolve(); // deja que _fetchLive cree el controller
    await repo.getMonthlyForPoint(-3.75, -73.25); // punto local: debe cancelar la consulta en vivo
    await livePromise;
    expect(liveSignal?.aborted).toBe(true);
  });
});

describe('parsePowerApiResponse', () => {
  it('excluye la clave anual YYYY13', () => {
    const parsed = parsePowerApiResponse(liveJsonOk(), { year: 2023 });
    expect(parsed.monthly['2023-13']).toBeUndefined();
    expect(Object.keys(parsed.monthly)).toEqual(['2023-01']);
  });

  it('mapea fill_value a null, nunca a 0', () => {
    const withFill = liveJsonOk({ properties: { parameter: { PRECTOTCORR: { '202301': -999 } } } });
    const parsed = parsePowerApiResponse(withFill, { year: 2023 });
    expect(parsed.monthly['2023-01']).toBeNull();
  });

  it('expone las unidades declaradas para verificarlas (mm/day)', () => {
    const parsed = parsePowerApiResponse(liveJsonOk(), { year: 2023 });
    expect(parsed.units).toBe('mm/day');
  });

  it('rechaza una respuesta sin unidades declaradas en vez de asumir mm/day', () => {
    const noUnits = liveJsonOk({ parameters: { PRECTOTCORR: {} } });
    expect(() => parsePowerApiResponse(noUnits, { year: 2023 })).toThrow(/unidades/);
  });

  it('rechaza una clave mensual malformada en vez de descartarla en silencio', () => {
    const badKey = liveJsonOk({ properties: { parameter: { PRECTOTCORR: { '2023-AB': 5 } } } });
    expect(() => parsePowerApiResponse(badKey, { year: 2023 })).toThrow();
  });

  it('rechaza un valor no numerico/no finito distinto del fill_value', () => {
    const badValue = liveJsonOk({ properties: { parameter: { PRECTOTCORR: { '202301': 'NaN' } } } });
    expect(() => parsePowerApiResponse(badValue, { year: 2023 })).toThrow();
  });

  it('expone las coordenadas de geometry como "reportadas", no como centro de celda', () => {
    const parsed = parsePowerApiResponse(liveJsonOk(), { year: 2023 });
    expect(parsed.coordsReported).toEqual({ lon: -73.25, lat: -3.75, elevation_m: 115 });
  });
});

describe('PowerRepository: solicitud en vivo (fuera de los 3 puntos)', () => {
  it('como maximo 1 solicitud pendiente: una segunda solicitud cancela la anterior', async () => {
    const fetchImpl = vi.fn(async (url, opts) => {
      if (String(url).includes('power-index.json')) return { ok: true, json: async () => ({ locations: [] }) };
      const signal = opts?.signal;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { ok: true, json: async () => liveJsonOk() };
    });
    const repo = new PowerRepository({ fetchImpl, baseUrl: '/data/' });
    const p1 = repo.getMonthlyForPoint(1, 1, { year: 2023 });
    const p2 = repo.getMonthlyForPoint(1, 1, { year: 2024 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe('aborted');
    expect(r2.ok).toBe(true);
  });

  it('usa la misma coordenada redondeada para la clave de cache y la URL (no mezcla puntos distintos)', async () => {
    const urls = [];
    const fetchImpl = vi.fn(async (url) => {
      urls.push(String(url));
      if (String(url).includes('power-index.json')) return { ok: true, json: async () => ({ locations: [] }) };
      return { ok: true, json: async () => liveJsonOk() };
    });
    const repo = new PowerRepository({ fetchImpl, baseUrl: '/data/' });
    await repo.getMonthlyForPoint(1.000049, 2.000049, { year: 2023 });
    await repo.getMonthlyForPoint(1.000012, 2.000012, { year: 2023 }); // redondea a la misma clave: debe venir de cache
    const liveUrls = urls.filter((u) => !u.includes('power-index.json'));
    expect(liveUrls).toHaveLength(1);
    expect(liveUrls[0]).toContain('latitude=1&');
    expect(liveUrls[0]).toContain('longitude=2&');
  });

  it('informa un error explicito de red/CORS sin fingir una respuesta', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('power-index.json')) return { ok: true, json: async () => ({ locations: [] }) };
      throw new TypeError('Failed to fetch');
    });
    const repo = new PowerRepository({ fetchImpl, baseUrl: '/data/', maxRetries: 0, retryBackoffMs: 1 });
    const result = await repo.getMonthlyForPoint(1, 1, { year: 2023 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('network-error');
  });
});
