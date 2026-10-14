import { describe, it, expect, vi } from 'vitest';
import {
  LruCache,
  GistempRepository,
  parsePeriod,
  shiftPeriod,
  neighborPeriods
} from '../src/data/repository.js';

function makeDataset(period, overrides = {}) {
  return {
    dataset: 'GISTEMP v4',
    variable: 'tempanomaly',
    period,
    units: 'K',
    baseline_period: '1951-1980',
    smoothing_radius_km: 1200,
    grid_resolution_deg: 2,
    axes: { lat_centers: [-1, 0, 1], lon_centers: [-1, 0, 1] },
    values: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    ...overrides
  };
}

function manifestFor(periods) {
  return { files: periods.map((p) => ({ period: p, path: `gistemp/${p}.json` })) };
}

function fetchImplFromMap(map, { delays = {} } = {}) {
  return vi.fn(async (url) => {
    const period = /(\d{4}-\d{2})\.json$/.exec(url)[1];
    if (delays[period]) await new Promise((r) => setTimeout(r, delays[period]));
    if (!(period in map)) return { ok: false, status: 404 };
    return { ok: true, json: async () => map[period] };
  });
}

describe('LruCache', () => {
  it('descarta la entrada menos recientemente usada al superar el tamano', () => {
    const cache = new LruCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' pasa a ser la mas reciente
    cache.set('c', 3); // deberia descartar 'b', no 'a'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });
});

describe('periodos', () => {
  it('parsePeriod/shiftPeriod cruzan el limite de ano', () => {
    expect(parsePeriod('2000-01')).toEqual({ year: 2000, month: 1 });
    expect(shiftPeriod('2000-01', -1)).toBe('1999-12');
    expect(shiftPeriod('2000-12', 1)).toBe('2001-01');
  });

  it('neighborPeriods solo devuelve periodos que existen en el manifiesto', () => {
    // Ambos vecinos directos existen: deberian devolverse los dos.
    expect(neighborPeriods('2000-02', ['2000-01', '2000-02', '2000-03'])).toEqual([
      '2000-01',
      '2000-03'
    ]);
    // Ningun vecino directo existe (solo un periodo lejano en el manifiesto).
    expect(neighborPeriods('2000-02', ['2000-09'])).toEqual([]);
  });
});

describe('GistempRepository', () => {
  it('carga el periodo pedido y precarga hasta 2 vecinos reales', async () => {
    const periods = ['2000-01', '2000-02', '2000-03'];
    const map = Object.fromEntries(periods.map((p) => [p, makeDataset(p)]));
    const fetchImpl = fetchImplFromMap(map);
    const repo = new GistempRepository({ fetchImpl, manifest: manifestFor(periods) });

    const result = await repo.loadPeriod('2000-02');
    expect(result.requestedPeriod).toBe('2000-02');
    expect(result.data.period).toBe('2000-02');

    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBe(3));
  });

  it('rechaza un periodo que no esta en el manifiesto', async () => {
    const repo = new GistempRepository({
      fetchImpl: fetchImplFromMap({}),
      manifest: manifestFor([])
    });
    await expect(repo.loadPeriod('2000-01')).rejects.toThrow();
  });

  it('rechaza un dataset invalido/vacio en vez de aceptarlo como valido', async () => {
    const periods = ['2000-01'];
    const fetchImpl = fetchImplFromMap({
      '2000-01': { period: '2000-01', values: [], axes: { lat_centers: [], lon_centers: [] } }
    });
    const repo = new GistempRepository({ fetchImpl, manifest: manifestFor(periods) });
    await expect(repo.loadPeriod('2000-01')).rejects.toThrow();
  });

  it('usa la cache en la segunda carga del mismo periodo (sin volver a fetch)', async () => {
    const periods = ['2000-01'];
    const fetchImpl = fetchImplFromMap({ '2000-01': makeDataset('2000-01') });
    const repo = new GistempRepository({ fetchImpl, manifest: manifestFor(periods) });

    await repo.loadPeriod('2000-01');
    const callsAfterFirst = fetchImpl.mock.calls.length;
    await repo.fetchPeriod('2000-01');
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  it('descarta una respuesta vieja cuando llega despues de una solicitud mas nueva (anti-carrera)', async () => {
    const periods = ['2000-01', '2000-02'];
    const map = {
      '2000-01': makeDataset('2000-01'),
      '2000-02': makeDataset('2000-02')
    };
    // El primer periodo tarda mas en responder que el segundo.
    const fetchImpl = fetchImplFromMap(map, { delays: { '2000-01': 30 } });
    const repo = new GistempRepository({ fetchImpl, manifest: manifestFor(periods) });

    const slow = repo.loadPeriod('2000-01');
    const fast = repo.loadPeriod('2000-02');

    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(slowResult).toBeNull(); // la solicitud vieja se descarta
    expect(fastResult.requestedPeriod).toBe('2000-02');
  });
});
