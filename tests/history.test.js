import { describe, it, expect, vi } from 'vitest';
import {
  searchCities,
  validateBirth,
  validatePlace,
  computeDelta,
  formatDegrees,
  formatMonthYear,
  buildStory,
  epochAnnouncement,
  loadHistoryResult
} from '../src/history/history-core.js';
import { createHistoryController } from '../src/history/history-controller.js';
import { createStore, createInitialState } from '../src/state/store.js';
import { GistempRepository } from '../src/data/repository.js';
import { encodePreset, decodePreset } from '../src/sharing/preset.js';

const SHA = 'sha-original';

function makeDataset(period, centre, overrides = {}) {
  const values = [0, 0, 0, 0, centre, 0, 0, 0, 0];
  return {
    dataset: 'GISTEMP v4',
    period,
    units: 'K',
    baseline_period: '1951-1980',
    smoothing_radius_km: 1200,
    grid_resolution_deg: 2,
    axes: { lat_centers: [-1, 0, 1], lon_centers: [-1, 0, 1] },
    values,
    source: { original_file_sha256: SHA },
    ...overrides
  };
}

const PERIODS = ['1880-01', '1990-01', '1990-02', '2026-07', '2026-08'];
const MANIFEST = { files: PERIODS.map((p) => ({ period: p, path: `gistemp/${p}.json` })) };

function makeRepo(map, { delays = {} } = {}) {
  const fetchImpl = vi.fn(async (url) => {
    const period = /(\d{4}-\d{2})\.json$/.exec(url)[1];
    if (delays[period]) await new Promise((r) => setTimeout(r, delays[period]));
    if (!(period in map)) return { ok: false, status: 404 };
    return { ok: true, json: async () => map[period] };
  });
  return { repo: new GistempRepository({ baseUrl: '', manifest: MANIFEST, fetchImpl }), fetchImpl };
}

const DATA = {
  '1880-01': makeDataset('1880-01', -0.3),
  '1990-01': makeDataset('1990-01', 0.5),
  '1990-02': makeDataset('1990-02', null),
  '2026-07': makeDataset('2026-07', 1.2),
  '2026-08': makeDataset('2026-08', 1.7)
};

describe('searchCities', () => {
  const rows = [
    [1, 'Lima', 'PE', -12.04, -77.03, 9000000, 'lima'],
    [2, 'Lima', 'US', 40.74, -84.1, 38000, 'lima'],
    [3, 'Iquitos', 'PE', -3.75, -73.25, 437000, 'iquitos'],
    [4, 'Limache', 'CL', -33, -71, 40000, 'limache'],
    [5, 'Salima', 'MW', -13, 34, 40000, 'salima']
  ];
  it('exige 2 letras y no distingue acentos ni mayusculas', () => {
    expect(searchCities(rows, 'l').total).toBe(0);
    expect(searchCities(rows, ' ÍQUITOS ').items.map((r) => r[0])).toEqual([3]);
  });
  it('mismo nombre en dos paises devuelve ambos; exacto antes que prefijo antes que subcadena', () => {
    const { items, total } = searchCities(rows, 'lima');
    expect(total).toBe(4);
    expect(items.map((r) => r[0])).toEqual([1, 2, 4, 5]);
  });
  it('limita a 10 filas pero informa el total', () => {
    const many = Array.from({ length: 30 }, (_, i) => [i, `Villa ${i}`, 'AR', 0, 0, 1000 - i, `villa ${i}`]);
    const { items, total } = searchCities(many, 'villa');
    expect(items).toHaveLength(10);
    expect(total).toBe(30);
  });
});

describe('validateBirth', () => {
  it('rechaza vacio (no es 0), formato invalido, antes de la fuente y futuro', () => {
    expect(validateBirth({ year: '', month: '3' }, PERIODS).reason).toBe('empty');
    expect(validateBirth({ year: '1990', month: '' }, PERIODS).reason).toBe('empty');
    expect(validateBirth({ year: '0', month: '1' }, PERIODS).reason).toBe('invalid');
    expect(validateBirth({ year: '1990', month: '13' }, PERIODS).reason).toBe('invalid');
    expect(validateBirth({ year: '1990', month: '0' }, PERIODS).reason).toBe('invalid');
    expect(validateBirth({ year: '1879', month: '12' }, PERIODS)).toMatchObject({ reason: 'beforeSource', min: '1880-01' });
    expect(validateBirth({ year: '2026', month: '9' }, PERIODS)).toMatchObject({ reason: 'afterLatest', max: '2026-08' });
    expect(validateBirth({ year: '2099', month: '1' }, PERIODS).reason).toBe('afterLatest');
  });
  it('acepta la primera y la ultima fecha reales; un hueco del manifiesto no se acepta', () => {
    expect(validateBirth({ year: '1880', month: '1' }, PERIODS)).toEqual({ ok: true, period: '1880-01' });
    expect(validateBirth({ year: '2026', month: '08' }, PERIODS)).toEqual({ ok: true, period: '2026-08' });
    expect(validateBirth({ year: '1950', month: '5' }, PERIODS).reason).toBe('notAvailable');
    expect(validateBirth({ year: '1990', month: '1' }, []).reason).toBe('noSource');
  });
  it('lugar: exige coordenadas finitas dentro de rango', () => {
    expect(validatePlace(null).ok).toBe(false);
    expect(validatePlace({ lat: 91, lon: 0 }).ok).toBe(false);
    expect(validatePlace({ lat: NaN, lon: 0 }).ok).toBe(false);
    expect(validatePlace({ lat: -3.7, lon: -73.2 }).ok).toBe(true);
  });
});

describe('diferencia y relato', () => {
  it('la diferencia es en grados de anomalia (no 273 ni %), el mismo periodo da 0 legitimo y NULL no es 0', () => {
    expect(computeDelta(0.5, 1.7)).toBe(1.2);
    expect(computeDelta(-0.3, 1.7)).toBe(2);
    expect(computeDelta(1.7, 1.7)).toBe(0);
    expect(computeDelta(null, 1.7)).toBeNull();
    expect(computeDelta(0.5, null)).toBeNull();
    expect(formatDegrees(0)).toBe('0.00');
    expect(formatDegrees(1.2, { signed: true })).toBe('+1.20');
    expect(formatDegrees(-0.3, { signed: true })).toBe('-0.30');
    expect(formatDegrees(null)).toBeNull();
  });

  it('formatea mes y ano en ES y EN', () => {
    expect(formatMonthYear('1990-01', 'es')).toBe('enero de 1990');
    expect(formatMonthYear('2026-08', 'en')).toBe('August 2026');
  });

  it('relato: anomalias respecto a la linea base, ultimos datos y diferencia; sin porcentajes ni causas', async () => {
    const { repo } = makeRepo(DATA);
    const loaded = await loadHistoryResult({ repository: repo, point: { lat: 0, lon: 0 }, periodA: '1990-01', periodB: '2026-08' });
    expect(loaded.ok).toBe(true);
    const text = buildStory(loaded.result, 'es', { latestPeriod: '2026-08' }).join(' ');
    expect(text).toContain('enero de 1990');
    expect(text).toContain('+0.50 °C');
    expect(text).toContain('1951–1980');
    expect(text).toContain('los últimos datos disponibles (agosto de 2026)');
    expect(text).toContain('+1.70 °C');
    expect(text).toContain('+1.20 °C');
    expect(text).not.toMatch(/%|273|causa por|demuestra que/);
    const en = buildStory(loaded.result, 'en', { latestPeriod: '2026-08' }).join(' ');
    expect(en).toContain('latest data available (August 2026)');
    expect(epochAnnouncement(loaded.result, 'a', 'es')).toContain('anomalía +0.50 °C');
  });

  it('con NULL no hay diferencia ni dato inventado', async () => {
    const { repo } = makeRepo(DATA);
    const loaded = await loadHistoryResult({ repository: repo, point: { lat: 0, lon: 0 }, periodA: '1990-02', periodB: '2026-08' });
    expect(loaded.result.a.value).toBeNull();
    expect(loaded.result.delta).toBeNull();
    const text = buildStory(loaded.result, 'es', { latestPeriod: '2026-08' }).join(' ');
    expect(text).toContain('Sin dato');
    expect(text).toContain('La diferencia no está disponible');
    expect(epochAnnouncement(loaded.result, 'a', 'es')).toContain('sin dato');
  });

  it('mismo periodo: una sola descarga y diferencia 0', async () => {
    const { repo, fetchImpl } = makeRepo(DATA);
    const loaded = await loadHistoryResult({ repository: repo, point: { lat: 0, lon: 0 }, periodA: '2026-08', periodB: '2026-08' });
    expect(loaded.result.delta).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(buildStory(loaded.result, 'es', { latestPeriod: '2026-08' }).join(' ')).toContain('Es el mismo mes');
  });
});

describe('loadHistoryResult (atomico)', () => {
  it('una descarga fallida no devuelve resultado parcial', async () => {
    const { repo } = makeRepo({ '1990-01': DATA['1990-01'] });
    const out = await loadHistoryResult({ repository: repo, point: { lat: 0, lon: 0 }, periodA: '1990-01', periodB: '2026-08' });
    expect(out).toMatchObject({ ok: false, reason: 'error' });
  });
  it('fuentes distintas o rejillas distintas se rechazan', async () => {
    const other = { ...DATA, '2026-08': makeDataset('2026-08', 1.7, { source: { original_file_sha256: 'otro' } }) };
    const a = await loadHistoryResult({ repository: makeRepo(other).repo, point: { lat: 0, lon: 0 }, periodA: '1990-01', periodB: '2026-08' });
    expect(a).toMatchObject({ ok: false, reason: 'sourceMismatch' });
    const grid = {
      ...DATA,
      '2026-08': makeDataset('2026-08', 1.7, { axes: { lat_centers: [-1, 0, 1], lon_centers: [-1, 0, 0.5] } })
    };
    const b = await loadHistoryResult({ repository: makeRepo(grid).repo, point: { lat: 0, lon: 0.4 }, periodA: '1990-01', periodB: '2026-08' });
    expect(b).toMatchObject({ ok: false, reason: 'gridMismatch' });
  });
  it('dos consultas simultaneas del mismo periodo comparten una sola descarga (fetchPeriod coalescido)', async () => {
    const { repo, fetchImpl } = makeRepo(DATA, { delays: { '2026-08': 10 } });
    const point = { lat: 0, lon: 0 };
    await Promise.all([
      loadHistoryResult({ repository: repo, point, periodA: '1990-01', periodB: '2026-08' }),
      loadHistoryResult({ repository: repo, point, periodA: '1880-01', periodB: '2026-08' })
    ]);
    const calls = fetchImpl.mock.calls.map((c) => c[0]).filter((u) => u.includes('2026-08'));
    expect(calls).toHaveLength(1);
  });
});

function makeHarness({ audio = { started: true, muted: false }, mapOverrides = {}, delays = {}, showEpoch = null } = {}) {
  const store = createStore({ ...createInitialState({ lang: 'es' }), activeTab: 'history', audio: { ...audio, volumeDb: -12 } });
  const { repo } = makeRepo({ ...DATA, ...mapOverrides }, { delays });
  const log = [];
  let mixerCount = 0;
  const mixer = {
    setChannel: (id, patch) => log.push(['channel', id, patch]),
    setSeed: (s) => log.push(['seed', s]),
    updateData: (d) => log.push(['data', d]),
    start: (o) => {
      mixer.lastStart = o;
      log.push(['start', o.mode]);
    },
    stop: () => log.push(['stop'])
  };
  const narrator = { speak: vi.fn(), cancel: vi.fn(), isSupported: () => true };
  const timers = [];
  const shown = { points: [], epochs: [] };
  const controller = createHistoryController({
    store,
    repository: repo,
    audioEngine: { isStarted: () => store.get().audio.started },
    narrator,
    createMixer: () => {
      mixerCount += 1;
      return mixer;
    },
    onShowPoint: (lat, lon) => shown.points.push([lat, lon]),
    onShowEpoch: (p) => {
      shown.epochs.push(p);
      return showEpoch ? showEpoch(p) : { ok: true };
    },
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeoutFn: (id) => {
      timers[id].cleared = true;
    }
  });
  return { store, controller, mixer, log, narrator, timers, shown, mixerCount: () => mixerCount };
}

const PLACE = { lat: 0, lon: 0, label: 'Origen' };

describe('createHistoryController', () => {
  it('submit valida y no escribe nada en el store ante errores', async () => {
    const h = makeHarness();
    expect(await h.controller.submit({ place: null, year: '1990', month: '1' })).toMatchObject({ ok: false, reason: 'noPlace' });
    expect(await h.controller.submit({ place: PLACE, year: '', month: '' })).toMatchObject({ ok: false, reason: 'empty' });
    expect(await h.controller.submit({ place: PLACE, year: '2030', month: '1' })).toMatchObject({ ok: false, reason: 'afterLatest' });
    expect(h.store.get().history.status).toBe('idle');
  });

  it('nunca reproduce sola: consultar deja el resultado listo sin audio', async () => {
    const h = makeHarness();
    const out = await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    expect(out.ok).toBe(true);
    const hist = h.store.get().history;
    expect(hist.status).toBe('ready');
    expect(hist.result.a.period).toBe('1990-01');
    expect(hist.result.b.period).toBe('2026-08');
    expect(hist.playing).toBeNull();
    expect(h.log.some((e) => e[0] === 'start')).toBe(false);
    expect(h.shown.points).toEqual([[0, 0]]);
  });

  it('antes y despues usan la misma semilla, modo, canales y orden', async () => {
    const h = makeHarness();
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    expect((await h.controller.play('a')).ok).toBe(true);
    h.mixer.lastStart.onEnd();
    expect((await h.controller.play('b')).ok).toBe(true);
    const seeds = h.log.filter((e) => e[0] === 'seed').map((e) => e[1]);
    expect(seeds).toEqual(['earth-jukebox', 'earth-jukebox']);
    const starts = h.log.filter((e) => e[0] === 'start').map((e) => e[1]);
    expect(starts).toEqual(['composition', 'composition']);
    const data = h.log.filter((e) => e[0] === 'data').map((e) => e[1]);
    expect(data[0]).toEqual({ temperature: 0.5, rain: null, ice: null });
    expect(data[1]).toEqual({ temperature: 1.7, rain: null, ice: null });
    expect(h.mixerCount()).toBe(1);
    expect(h.shown.epochs).toEqual(['1990-01', '2026-08']);
  });

  it('secuencia automatica: antes, pausa anunciada, despues; Detener corta el temporizador', async () => {
    const h = makeHarness();
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    h.controller.setVoice(true);
    expect((await h.controller.playAuto()).ok).toBe(true);
    expect(h.narrator.speak).toHaveBeenCalledTimes(1);
    expect(h.store.get().history.playing).toMatchObject({ epoch: 'a', auto: true, phase: 'music' });
    h.mixer.lastStart.onEnd();
    expect(h.store.get().history.playing).toMatchObject({ epoch: 'b', phase: 'gap' });
    expect(h.timers).toHaveLength(1);
    h.controller.stop();
    expect(h.timers[0].cleared).toBe(true);
    await h.timers[0].fn();
    expect(h.log.filter((e) => e[0] === 'start')).toHaveLength(1);
    expect(h.store.get().history.playing).toBeNull();

    await h.controller.playAuto();
    h.mixer.lastStart.onEnd();
    await h.timers[1].fn();
    expect(h.store.get().history.playing).toMatchObject({ epoch: 'b', phase: 'music' });
    expect(h.narrator.speak).toHaveBeenCalledTimes(3);
    h.mixer.lastStart.onEnd();
    expect(h.store.get().history.ended).toBe(true);
    expect(h.store.get().history.playing).toBeNull();
  });

  it('un fin tardio de una reproduccion detenida no avanza la secuencia', async () => {
    const h = makeHarness();
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    await h.controller.playAuto();
    const staleEnd = h.mixer.lastStart.onEnd;
    h.controller.stop();
    staleEnd();
    expect(h.timers).toHaveLength(0);
  });

  it('sin audio, en silencio, fuera de la pestana o sin dato no suena', async () => {
    const off = makeHarness({ audio: { started: false, muted: false } });
    await off.controller.submit({ place: PLACE, year: '1990', month: '1' });
    expect(await off.controller.play('a')).toMatchObject({ ok: false, reason: 'audioOff' });

    const muted = makeHarness({ audio: { started: true, muted: true } });
    await muted.controller.submit({ place: PLACE, year: '1990', month: '1' });
    expect(await muted.controller.play('a')).toMatchObject({ ok: false, reason: 'muted' });

    const nul = makeHarness();
    await nul.controller.submit({ place: PLACE, year: '1990', month: '2' });
    expect(await nul.controller.play('a')).toMatchObject({ ok: false, reason: 'noData' });
    expect(await nul.controller.playAuto()).toMatchObject({ ok: false, reason: 'noData' });
    expect((await nul.controller.play('b')).ok).toBe(true);
    expect(nul.store.get().history.result.delta).toBeNull();
  });

  it('silenciar o salir de la pestana corta audio, voz y temporizadores (enforce)', async () => {
    const h = makeHarness();
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    await h.controller.playAuto();
    h.store.set((s) => ({ audio: { ...s.audio, muted: true } }));
    h.controller.enforce(h.store.get());
    expect(h.store.get().history.playing).toBeNull();
    expect(h.log.at(-1)).toEqual(['stop']);

    h.store.set((s) => ({ audio: { ...s.audio, muted: false } }));
    await h.controller.playAuto();
    h.store.set({ activeTab: 'dj' });
    h.controller.enforce(h.store.get());
    expect(h.store.get().history.playing).toBeNull();
    expect(h.narrator.cancel).toHaveBeenCalled();
    expect(await h.controller.play('a')).toMatchObject({ ok: false, reason: 'tab' });
  });

  it('una consulta lenta superada por otra nunca escribe su resultado (respuesta tardia)', async () => {
    const h = makeHarness({ delays: { '1880-01': 30 } });
    const slow = h.controller.submit({ place: PLACE, year: '1880', month: '1' });
    const fast = h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    expect(await fast).toMatchObject({ ok: true });
    expect(await slow).toMatchObject({ ok: false, reason: 'stale' });
    expect(h.store.get().history.result.a.period).toBe('1990-01');
  });

  it('salir de la pestana durante la carga cancela la consulta', async () => {
    const h = makeHarness({ delays: { '1990-01': 20 } });
    const pending = h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    expect(h.store.get().history.status).toBe('loading');
    h.store.set({ activeTab: 'explore' });
    h.controller.enforce(h.store.get());
    expect(await pending).toMatchObject({ ok: false, reason: 'stale' });
    expect(h.store.get().history.status).toBe('idle');
    expect(h.store.get().history.result).toBeNull();
  });

  it('un error de carga no deja el resultado anterior etiquetado como nuevo', async () => {
    const h = makeHarness({ mapOverrides: { '1880-01': undefined } });
    h.store.set({ history: { ...h.store.get().history, status: 'ready', result: { stale: true } } });
    const out = await h.controller.submit({ place: PLACE, year: '1880', month: '1' });
    expect(out).toMatchObject({ ok: false, reason: 'error' });
    expect(h.store.get().history.status).toBe('error');
    expect(h.store.get().history.result).toBeNull();
  });

  it('clear borra el resultado pero conserva la preferencia de voz', async () => {
    const h = makeHarness();
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    h.controller.setVoice(true);
    h.controller.clear();
    expect(h.store.get().history.result).toBeNull();
    expect(h.store.get().history.status).toBe('idle');
    expect(h.store.get().history.voice).toBe(true);
  });

  it('applyShared carga sin audio y rechaza periodos inexistentes', async () => {
    const h = makeHarness();
    expect((await h.controller.applyShared({ point: { lat: 0, lon: 0 }, a: '1990-01', b: '2026-08' })).ok).toBe(true);
    expect(h.log.some((e) => e[0] === 'start')).toBe(false);
    expect(await h.controller.applyShared({ point: { lat: 0, lon: 0 }, a: '1700-01', b: '2026-08' })).toMatchObject({
      ok: false,
      reason: 'notAvailable'
    });
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const starts = (h) => h.log.filter((e) => e[0] === 'start').length;

describe('escucha: el globo confirma la epoca antes de sonar (Bug 1)', () => {
  it('no hay mixer.start ni voz hasta que onShowEpoch resuelve; fase loading mientras tanto', async () => {
    const d = deferred();
    const h = makeHarness({ showEpoch: () => d.promise });
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    h.controller.setVoice(true);
    const pending = h.controller.play('a');
    expect(h.store.get().history.playing).toMatchObject({ epoch: 'a', phase: 'loading' });
    expect(starts(h)).toBe(0);
    expect(h.narrator.speak).not.toHaveBeenCalled();
    d.resolve({ ok: true });
    expect(await pending).toMatchObject({ ok: true });
    expect(starts(h)).toBe(1);
    expect(h.narrator.speak).toHaveBeenCalledTimes(1);
    expect(h.store.get().history.playing).toMatchObject({ phase: 'music' });
  });

  it('si el globo falla (resultado o excepcion) no hay audio y queda playError', async () => {
    for (const showEpoch of [() => ({ ok: false, reason: 'error' }), () => Promise.reject(new Error('red'))]) {
      const h = makeHarness({ showEpoch });
      await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
      expect(await h.controller.play('a')).toMatchObject({ ok: false, reason: 'epochError' });
      expect(starts(h)).toBe(0);
      expect(h.narrator.speak).not.toHaveBeenCalled();
      expect(h.store.get().history).toMatchObject({ playing: null, playError: 'epoch' });
    }
  });

  it('Detener antes de resolver impide el arranque tardio', async () => {
    const d = deferred();
    const h = makeHarness({ showEpoch: () => d.promise });
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    const pending = h.controller.play('a');
    h.controller.stop();
    d.resolve({ ok: true });
    expect(await pending).toMatchObject({ ok: false, reason: 'stale' });
    expect(starts(h)).toBe(0);
    expect(h.store.get().history.playing).toBeNull();
  });

  it('A lenta luego B: A nunca suena aunque resuelva despues', async () => {
    const dA = deferred();
    const dB = deferred();
    const h = makeHarness({ showEpoch: (p) => (p === '1990-01' ? dA.promise : dB.promise) });
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    const a = h.controller.play('a');
    const b = h.controller.play('b');
    dB.resolve({ ok: true });
    expect(await b).toMatchObject({ ok: true });
    dA.resolve({ ok: true });
    expect(await a).toMatchObject({ ok: false, reason: 'stale' });
    expect(starts(h)).toBe(1);
    expect(h.store.get().history.playing).toMatchObject({ epoch: 'b', phase: 'music' });
  });

  it('silenciar o salir de la pestana antes de resolver no arranca nada', async () => {
    for (const change of [{ audio: { started: true, muted: true, volumeDb: -12 } }, { activeTab: 'dj' }]) {
      const d = deferred();
      const h = makeHarness({ showEpoch: () => d.promise });
      await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
      const pending = h.controller.play('a');
      h.store.set(change);
      h.controller.enforce(h.store.get());
      d.resolve({ ok: true });
      await pending;
      expect(starts(h)).toBe(0);
      expect(h.narrator.speak).not.toHaveBeenCalled();
    }
  });

  it('secuencia automatica: Detener durante la carga de la segunda epoca no la arranca', async () => {
    const d = deferred();
    const h = makeHarness({ showEpoch: (p) => (p === '2026-08' ? d.promise : { ok: true }) });
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    await h.controller.playAuto();
    h.mixer.lastStart.onEnd();
    const pending = h.timers[0].fn();
    expect(h.store.get().history.playing).toMatchObject({ epoch: 'b', phase: 'loading' });
    h.controller.stop();
    d.resolve({ ok: true });
    await pending;
    expect(starts(h)).toBe(1);
  });
});

describe('cambios de lugar/fecha/globo invalidan consulta y audio (Bug 2)', () => {
  it('cancelQuery detiene la escucha de A, descarta el resultado y no toca nada en reposo', async () => {
    const h = makeHarness();
    h.controller.cancelQuery();
    expect(h.narrator.cancel).not.toHaveBeenCalled();
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    await h.controller.play('a');
    h.controller.cancelQuery();
    expect(h.log.at(-1)).toEqual(['stop']);
    expect(h.store.get().history).toMatchObject({ status: 'idle', result: null, playing: null });
  });

  it('consulta lenta A + usuario elige B: la respuesta tardia de A no escribe ni mueve el globo', async () => {
    const h = makeHarness({ delays: { '1880-01': 30 } });
    const slow = h.controller.submit({ place: PLACE, year: '1880', month: '1' });
    h.controller.cancelQuery();
    expect(await slow).toMatchObject({ ok: false, reason: 'stale' });
    expect(h.store.get().history).toMatchObject({ status: 'idle', result: null });
    expect(h.shown.points).toEqual([]);
    expect(starts(h)).toBe(0);
  });

  it('onShowPoint propio no se autocancela: submit deja el resultado y el punto mostrado', async () => {
    const h = makeHarness();
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    expect(h.store.get().history.status).toBe('ready');
    expect(h.shown.points).toEqual([[0, 0]]);
  });

  it('un error de epoca se limpia al cancelar', async () => {
    const h = makeHarness({ showEpoch: () => ({ ok: false }) });
    await h.controller.submit({ place: PLACE, year: '1990', month: '1' });
    await h.controller.play('a');
    expect(h.store.get().history.playError).toBe('epoch');
    h.controller.cancelQuery();
    expect(h.store.get().history.playError).toBeNull();
  });
});

describe('enlace de historia (preset v3)', () => {
  const base = {
    mode: 'history',
    selectedPoint: { lat: -3.75, lon: -73.25 },
    period: '2026-08',
    lang: 'es',
    seed: 'earth-jukebox',
    bpm: 96,
    history: { a: '1990-01', b: '2026-08' },
    dataVersions: { gistemp: SHA }
  };

  it('ida y vuelta conserva punto, dos periodos y musica; no incluye dia exacto ni nombre', () => {
    const encoded = encodePreset({ ...base, name: 'Ana', birthDay: '1990-01-17' });
    const decoded = decodePreset(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.preset.mode).toBe('history');
    expect(decoded.preset.history).toEqual({ a: '1990-01', b: '2026-08' });
    expect(decoded.preset.selectedPoint).toEqual({ lat: -3.75, lon: -73.25 });
    const raw = JSON.stringify(JSON.parse(Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()));
    expect(raw).not.toMatch(/Ana|1990-01-17|birth/);
  });

  it('un bloque h invalido se rechaza y los enlaces viejos sin h siguen funcionando', () => {
    const { history, ...old } = base;
    const oldDecoded = decodePreset(encodePreset({ ...old, mode: 'dj' }));
    expect(oldDecoded.ok).toBe(true);
    expect(oldDecoded.preset.history).toBeNull();
    expect(oldDecoded.preset.mode).toBe('dj');

    const payload = JSON.parse(Buffer.from(encodePreset(base).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    payload.h = { a: 'ayer', b: '2026-08' };
    const bad = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = decodePreset(bad);
    expect(result.ok).toBe(false);
    expect(result.fields).toContain('history');
  });
});
