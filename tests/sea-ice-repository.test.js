import { describe, it, expect, vi } from 'vitest';
import { IceRepository } from '../src/data/sea-ice-repository.js';

function makeIceDataset(period, overrides = {}) {
  return {
    dataset: 'NOAA/NSIDC G02135 Sea Ice Index v4.0 (derivado de algoritmos NASA GSFC)',
    version_hash: 'abc123',
    variable: 'sea_ice_concentration',
    period,
    units: 'fraction (0.0-1.0) of valid ocean area covered by sea ice',
    grid_resolution_deg: 2,
    axes: { lat_centers: [-1, 0, 1], lon_centers: [-1, 0, 1] },
    values: [null, 0.5, 0.8, null, 0, 0.2, null, null, 1],
    coverage: [0, 10, 12, 0, 5, 3, 0, 0, 20],
    ...overrides
  };
}

function fetchImplFromMap(map) {
  return vi.fn(async (url) => {
    const match = /sea-ice-g02135\/(\d{4}-\d{2})\.json$/.exec(url);
    const period = match?.[1];
    if (!period || !(period in map)) return { ok: false, status: 404 };
    return { ok: true, json: async () => map[period] };
  });
}

describe('IceRepository', () => {
  it('hasPeriod/availablePeriods solo reportan la serie real pasada al constructor', () => {
    const repo = new IceRepository({ periods: ['2023-01', '2023-09'] });
    expect(repo.hasPeriod('2023-01')).toBe(true);
    expect(repo.hasPeriod('2023-02')).toBe(false);
    expect(repo.availablePeriods).toEqual(['2023-01', '2023-09']);
  });

  it('un periodo fuera de la serie 2023 se reporta explicitamente, nunca se extrapola', async () => {
    const repo = new IceRepository({ periods: ['2023-01'], fetchImpl: fetchImplFromMap({}) });
    const result = await repo.getCellForPoint(0, 0, '2024-01');
    expect(result).toEqual({ ok: false, reason: 'out-of-series', period: '2024-01' });
  });

  it('busca la celda mas cercana reutilizando la misma rejilla que GISTEMP (findNearestCell)', async () => {
    const dataset = makeIceDataset('2023-01');
    const repo = new IceRepository({
      periods: ['2023-01'],
      fetchImpl: fetchImplFromMap({ '2023-01': dataset })
    });
    // lat_centers=[-1,0,1], lon_centers=[-1,0,1]; (lat=-1,lon=1) -> latIdx=0,
    // lonIdx=2 -> indice 0*3+2=2 -> values[2]=0.8.
    const result = await repo.getCellForPoint(-1, 1, '2023-01');
    expect(result.ok).toBe(true);
    expect(result.cell.value).toBe(0.8);
  });

  it('un valor real 0.0 (fuente bajo el umbral de deteccion del 15%, no ausencia absoluta) se distingue de null', async () => {
    const dataset = makeIceDataset('2023-01');
    const repo = new IceRepository({
      periods: ['2023-01'],
      fetchImpl: fetchImplFromMap({ '2023-01': dataset })
    });
    // (lat=0,lon=0) -> latIdx=1,lonIdx=1 -> indice 4 -> values[4]=0.
    const result = await repo.getCellForPoint(0, 0, '2023-01');
    expect(result.ok).toBe(true);
    expect(result.cell.value).toBe(0);
  });

  it('una celda sin pixel oceanico valido devuelve cell.value === null, nunca 0', async () => {
    const dataset = makeIceDataset('2023-01');
    const repo = new IceRepository({
      periods: ['2023-01'],
      fetchImpl: fetchImplFromMap({ '2023-01': dataset })
    });
    // lat_centers=[-1,0,1], lon_centers=[-1,0,1]; (lat=-1,lon=-1) -> indice 0 -> null
    const result = await repo.getCellForPoint(-1, -1, '2023-01');
    expect(result.ok).toBe(true);
    expect(result.cell.value).toBeNull();
  });

  it('cachea por periodo: una segunda consulta al mismo periodo no vuelve a pedir red', async () => {
    const dataset = makeIceDataset('2023-01');
    const fetchImpl = fetchImplFromMap({ '2023-01': dataset });
    const repo = new IceRepository({ periods: ['2023-01'], fetchImpl });
    await repo.getCellForPoint(0, 0, '2023-01');
    await repo.getCellForPoint(1, 1, '2023-01');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('un JSON mal formado (sin coverage) se rechaza con un error explicito, no se acepta a medias', async () => {
    const dataset = makeIceDataset('2023-01', { coverage: undefined });
    const repo = new IceRepository({
      periods: ['2023-01'],
      fetchImpl: fetchImplFromMap({ '2023-01': dataset })
    });
    const result = await repo.getCellForPoint(0, 0, '2023-01');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
  });

  it('bounded cancel guard: una llamada mas reciente descarta la respuesta vieja que llega tarde', async () => {
    const datasetA = makeIceDataset('2023-01');
    const datasetB = makeIceDataset('2023-09', { values: [null, null, null, null, null, null, null, null, 0.1] });
    let resolveFirst;
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('2023-01')) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ ok: true, json: async () => datasetA });
        });
      }
      return { ok: true, json: async () => datasetB };
    });
    const repo = new IceRepository({ periods: ['2023-01', '2023-09'], fetchImpl });

    const stalePromise = repo.getCellForPoint(0, 0, '2023-01');
    const freshPromise = repo.getCellForPoint(0, 0, '2023-09');
    const fresh = await freshPromise;
    expect(fresh.ok).toBe(true);
    resolveFirst();
    const stale = await stalePromise;
    expect(stale).toEqual({ ok: false, reason: 'stale' });
  });

  it('REGRESION: una llamada diferida a un periodo REAL (2023) no sobrevive a un cambio posterior a un periodo FUERA de serie (2024)', async () => {
    // Bug real corregido: requestVersion se incrementaba DESPUES del
    // retorno temprano "out-of-series", asi que una segunda llamada a un
    // periodo fuera de serie nunca invalidaba la primera (2023) todavia en
    // vuelo; esta ultima podia resolver tarde y pisar el estado mas nuevo.
    const dataset2023 = makeIceDataset('2023-01');
    let resolveSlow;
    const fetchImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSlow = () => resolve({ ok: true, json: async () => dataset2023 });
        })
    );
    const repo = new IceRepository({ periods: ['2023-01'], fetchImpl });

    const slowPromise = repo.getCellForPoint(0, 0, '2023-01'); // en vuelo, real, lenta
    const outOfSeries = await repo.getCellForPoint(0, 0, '2024-01'); // el usuario cambia a un periodo sin serie
    expect(outOfSeries).toEqual({ ok: false, reason: 'out-of-series', period: '2024-01' });

    resolveSlow();
    const slowResult = await slowPromise;
    expect(slowResult).toEqual({ ok: false, reason: 'stale' }); // NUNCA debe llegar como ok:true tras el cambio
  });

  it('timeout acotado: una solicitud que nunca resuelve termina en error explicito, no en hang ni en 0 fabricado', async () => {
    // El mock real respeta AbortSignal (igual que fetch() real): sin esto
    // no se puede distinguir "la solicitud nunca llega" de "el timeout de
    // produccion funciona", porque ninguna de las dos resuelve nunca sin
    // que algo reaccione al abort().
    const fetchImpl = vi.fn(
      (url, { signal } = {}) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );
    const repo = new IceRepository({ periods: ['2023-01'], fetchImpl, fetchTimeoutMs: 20 });
    const result = await repo.getCellForPoint(0, 0, '2023-01');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.detail).toMatch(/[Tt]iempo de espera/);
  }, 2000);

  it('coalescencia: dos solicitudes concurrentes al MISMO periodo comparten una sola peticion de red en vuelo', async () => {
    const dataset = makeIceDataset('2023-01');
    const fetchImpl = fetchImplFromMap({ '2023-01': dataset });
    const repo = new IceRepository({ periods: ['2023-01'], fetchImpl });

    // La segunda llamada (b), por ser la MAS RECIENTE, es la que debe
    // ganar segun el cancel-guard (igual que si fueran periodos
    // distintos); la primera (a) queda 'stale' aunque pida el MISMO
    // periodo. Lo que prueba la coalescencia es que, aun asi, solo se hizo
    // UNA peticion de red real (fetchImpl), no dos.
    const [a, b] = await Promise.all([repo.getCellForPoint(0, 0, '2023-01'), repo.getCellForPoint(1, 1, '2023-01')]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ ok: false, reason: 'stale' });
    expect(b.ok).toBe(true);
  });

  it('cache acotada a 12 entradas (LruCache, igual que GistempRepository)', async () => {
    const periods = Array.from({ length: 13 }, (_, i) => `2023-${String(i + 1).padStart(2, '0')}`).slice(0, 12);
    periods.push('2024-01'); // 13a entrada, deberia descartar la mas vieja (2023-01)
    const datasets = Object.fromEntries(periods.map((p) => [p, makeIceDataset(p)]));
    const fetchImpl = fetchImplFromMap(datasets);
    const repo = new IceRepository({ periods, fetchImpl });
    for (const p of periods) await repo.getCellForPoint(0, 0, p);
    expect(repo.cache.size).toBeLessThanOrEqual(12);
    expect(repo.cache.has('2023-01')).toBe(false);
    expect(repo.cache.has('2024-01')).toBe(true);
  });
});
