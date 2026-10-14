import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStore, createInitialState } from '../src/state/store.js';
import { createDjPanel, ICE_EXPLORE_POINTS } from '../src/ui/dj-panel.js';
import { DjMixer } from '../src/audio/mixer.js';
import { t } from '../src/i18n/index.js';

// DOM minimo hecho a mano (sin jsdom, igual que integration-accessible-sync):
// dj-panel.js crea casi todo su propio arbol con createElement/append, solo
// necesita getElementById('dj-panel') como contenedor raiz.
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this._listeners = {};
    this.attributes = {};
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this._classes = new Set();
    const self = this;
    this.classList = {
      add: (...names) => names.forEach((n) => self._classes.add(n)),
      remove: (...names) => names.forEach((n) => self._classes.delete(n)),
      toggle: (name, force) => {
        const has = force ?? !self._classes.has(name);
        if (has) self._classes.add(name);
        else self._classes.delete(name);
        return has;
      },
      contains: (name) => self._classes.has(name)
    };
  }
  get className() {
    return [...this._classes].join(' ');
  }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  addEventListener(type, handler) {
    (this._listeners[type] ??= []).push(handler);
  }
  dispatch(type, event = {}) {
    for (const handler of this._listeners[type] ?? []) handler(event);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  set innerHTML(_v) {
    this.children = [];
  }
  get innerHTML() {
    return '';
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
}

function createMockTone() {
  const transportEvents = new Map();
  let nextId = 1;
  const Transport = {
    bpm: { value: 72 },
    scheduleRepeat: vi.fn((cb) => {
      const id = nextId++;
      transportEvents.set(id, cb);
      return id;
    }),
    clear: vi.fn((id) => transportEvents.delete(id)),
    start: vi.fn(),
    stop: vi.fn(),
    _events: transportEvents
  };
  class FakeNode {
    constructor() {
      this.gain = { value: 1, rampTo: vi.fn() };
    }
    chain() {
      return this;
    }
    dispose() {}
  }
  class FakeSynth extends FakeNode {
    triggerAttackRelease = vi.fn();
    triggerRelease = vi.fn();
    releaseAll = vi.fn();
  }
  return {
    Transport,
    Gain: FakeNode,
    Synth: FakeSynth,
    FMSynth: FakeSynth,
    MembraneSynth: FakeSynth,
    PolySynth: FakeSynth,
    NoiseSynth: FakeSynth,
    dbToGain: (db) => (db === -Infinity ? 0 : 10 ** (db / 20)),
    Time: () => ({ toSeconds: () => 0.5 }),
    now: () => 0
  };
}

function buildFakeDocument() {
  const dj = new FakeElement('div');
  return {
    getElementById: (id) => (id === 'dj-panel' ? dj : null),
    createElement: (tag) => new FakeElement(tag)
  };
}

function findInput(root, id) {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const found = findInput(c, id);
    if (found) return found;
  }
  return null;
}

describe('DJ panel: lifecycle del mezclador (no reinicia el PRNG por renders ajenos)', () => {
  let store;
  let audioEngine;

  beforeEach(() => {
    globalThis.document = buildFakeDocument();
    store = createStore(createInitialState({ lang: 'es' }));
    audioEngine = {
      Tone: createMockTone(),
      isStarted: () => true,
      getBus: () => ({})
    };
  });

  it('setSeed solo se llama cuando la semilla realmente cambia, nunca en cada render (volumen/mute/periodo/otros)', () => {
    const setSeedSpy = vi.spyOn(DjMixer.prototype, 'setSeed');
    try {
      const djPanel = createDjPanel({ store, audioEngine, powerRepository: { getMonthlyForPoint: () => new Promise(() => {}) } });
      store.set({
        selectedPoint: { lat: -3.75, lon: -73.25 },
        confirmedPeriod: '2023-01',
        cell: { value: 1.2 },
        activeTab: 'dj',
        dj: { ...store.get().dj, playing: true }
      });

      // El primer render con dj.playing=true crea el mezclador y SI aplica
      // la semilla inicial una vez.
      djPanel.render(store.get());
      expect(setSeedSpy).toHaveBeenCalledTimes(1);
      expect(audioEngine.Tone.Transport.scheduleRepeat).toHaveBeenCalledTimes(1);

      // Renders repetidos SIN cambiar dj.seed (p.ej. toggles de volumen,
      // mute, periodo u otro store.set cualquiera) NUNCA deben volver a
      // llamar setSeed: eso reiniciaria el PRNG de lluvia a mitad de una
      // mezcla ya en marcha (ver audio/mixer.js: setSeed reinicia rand y
      // pulseIndex).
      for (let i = 0; i < 5; i += 1) {
        store.set({ audio: { ...store.get().audio, volumeDb: -10 - i } });
        djPanel.render(store.get());
      }
      expect(setSeedSpy).toHaveBeenCalledTimes(1);
      expect(audioEngine.Tone.Transport.scheduleRepeat).toHaveBeenCalledTimes(1); // tampoco reinicia el pulso

      // Cambiar dj.seed explicitamente SI debe volver a llamar setSeed
      // (una sola vez, por el cambio real).
      store.set({ dj: { ...store.get().dj, seed: 'otra-semilla' } });
      djPanel.render(store.get());
      expect(setSeedSpy).toHaveBeenCalledTimes(2);

      // Renders posteriores con esa MISMA semilla nueva tampoco repiten la llamada.
      djPanel.render(store.get());
      expect(setSeedSpy).toHaveBeenCalledTimes(2);
    } finally {
      setSeedSpy.mockRestore();
    }
  });
});

describe('DJ panel: aria-label unico por canal', () => {
  beforeEach(() => {
    globalThis.document = buildFakeDocument();
  });

  it('activar/solo/ganancia de temperatura y lluvia tienen aria-label distintos entre si', () => {
    const store = createStore(createInitialState({ lang: 'es' }));
    const audioEngine = { Tone: createMockTone(), isStarted: () => false, getBus: () => ({}) };
    const djPanel = createDjPanel({ store, audioEngine, powerRepository: { getMonthlyForPoint: () => new Promise(() => {}) } });
    store.set({ activeTab: 'dj' });
    djPanel.render(store.get());

    const dj = document.getElementById('dj-panel');
    const labels = [];
    function collect(el) {
      const al = el.getAttribute?.('aria-label');
      if (al) labels.push(al);
      for (const c of el.children ?? []) collect(c);
    }
    collect(dj);
    // Sin la correccion, ambos sliders de ganancia (y los botones activar/
    // solo) comparten exactamente el mismo texto generico entre canales; con
    // la correccion cada uno incluye el nombre del canal y son todos
    // distintos entre si.
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('DJ panel: borrador de #dj-seed no se pierde con otros renders', () => {
  let store;
  let audioEngine;
  let djPanel;
  let seedInput;

  beforeEach(() => {
    globalThis.document = buildFakeDocument();
    store = createStore(createInitialState({ lang: 'es' }));
    audioEngine = { Tone: createMockTone(), isStarted: () => false, getBus: () => ({}) };
    djPanel = createDjPanel({ store, audioEngine, powerRepository: { getMonthlyForPoint: () => new Promise(() => {}) } });
    djPanel.render(store.get());
    seedInput = findInput(document.getElementById('dj-panel'), 'dj-seed');
  });

  it('escribir (evento "input", como Playwright fill) confirma la semilla de inmediato, sin depender de change/blur', () => {
    seedInput.value = 'demo-peru';
    seedInput.dispatch('input');
    expect(store.get().dj.seed).toBe('demo-peru');
  });

  it('repro exacto: escribir semilla y luego cambiar BPM (otro render) NO borra el borrador ya escrito', () => {
    seedInput.dispatch('focus');
    seedInput.value = 'demo-peru';
    seedInput.dispatch('input');

    // Mover el foco/cambiar BPM dispara otro store.set -> otro render()
    // completo del panel, igual que en el navegador real.
    store.set({ dj: { ...store.get().dj, bpm: 84 } });
    djPanel.render(store.get());

    expect(store.get().dj.seed).toBe('demo-peru'); // antes: seguia en 'earth-jukebox'
    expect(seedInput.value).toBe('demo-peru'); // el campo tampoco se revierte visualmente
  });

  it('al perder el foco (guardar), el valor final sigue siendo el escrito, no el valor por defecto', () => {
    seedInput.dispatch('focus');
    seedInput.value = 'demo-peru';
    seedInput.dispatch('input');
    seedInput.dispatch('blur');
    djPanel.render(store.get());
    expect(store.get().dj.seed).toBe('demo-peru');
    expect(seedInput.value).toBe('demo-peru');
  });

  it('sin foco, render() SI sincroniza el campo desde el estado (p.ej. al restaurar un preset)', () => {
    store.set({ dj: { ...store.get().dj, seed: 'desde-preset' } });
    djPanel.render(store.get());
    expect(seedInput.value).toBe('desde-preset');
  });

  it('respeta maxlength 64 (mismo limite que sharing/preset.js MAX_SEED_LENGTH)', () => {
    expect(seedInput.maxLength).toBe(64);
  });
});

function collectByDataI18nPrefix(root, prefix, { tag } = {}) {
  const found = [];
  function walk(el) {
    const key = el.getAttribute?.('data-i18n');
    if (key && key.startsWith(prefix) && (!tag || el.tagName === tag)) found.push(el);
    for (const c of el.children ?? []) walk(c);
  }
  walk(root);
  return found;
}

describe('DJ panel: canal de hielo real (NOAA/NSIDC G02135)', () => {
  let store;
  let audioEngine;

  beforeEach(() => {
    globalThis.document = buildFakeDocument();
    store = createStore(createInitialState({ lang: 'es' }));
    audioEngine = { Tone: createMockTone(), isStarted: () => true, getBus: () => ({}) };
  });

  it('el canal de hielo ya NO esta deshabilitado (enable/solo/ganancia activos, a diferencia de incendios)', () => {
    const djPanel = createDjPanel({
      store,
      audioEngine,
      powerRepository: { getMonthlyForPoint: () => new Promise(() => {}) },
      iceRepository: { hasPeriod: () => false, getCellForPoint: async () => ({ ok: false, reason: 'out-of-series' }) }
    });
    store.set({ activeTab: 'dj' });
    djPanel.render(store.get());

    const dj = document.getElementById('dj-panel');
    function findRow(el, cls) {
      if (el.className?.includes?.(cls)) return el;
      for (const c of el.children ?? []) {
        const found = findRow(c, cls);
        if (found) return found;
      }
      return null;
    }
    // Las filas de canal no tienen id propio; se identifican por el orden
    // de creacion (temperature, rain, ice, fires) dentro de #dj-channels.
    const channelsContainer = dj.children.find((c) => c.id === 'dj-channels');
    expect(channelsContainer.children.length).toBe(4);
    const [, , iceRow, firesRow] = channelsContainer.children;
    expect(iceRow._classes.has('is-pending')).toBe(false);
    expect(firesRow._classes.has('is-pending')).toBe(true);
  });

  it('al seleccionar punto+periodo, consulta iceRepository y pasa el valor resuelto al mezclador', async () => {
    const getCellForPoint = vi.fn(async () => ({
      ok: true,
      period: '2023-01',
      cell: { value: 0.73, index: 42 },
      dataset: { coverage: new Array(50).fill(10).fill(7, 42, 43), version_hash: 'hash-abc', dataset: 'NOAA/NSIDC G02135' }
    }));
    const iceRepository = { hasPeriod: () => true, getCellForPoint };
    const djPanel = createDjPanel({
      store,
      audioEngine,
      powerRepository: { getMonthlyForPoint: () => new Promise(() => {}) },
      iceRepository
    });
    store.set({
      selectedPoint: { lat: 75.19, lon: -133.67 },
      confirmedPeriod: '2023-01',
      cell: { value: null },
      activeTab: 'dj',
      dj: { ...store.get().dj, playing: true }
    });
    djPanel.render(store.get());
    await Promise.resolve();
    await Promise.resolve();

    expect(getCellForPoint).toHaveBeenCalledWith(75.19, -133.67, '2023-01');
    djPanel.render(store.get());
    expect(store.get().dj.iceInfo.value).toBe(0.73);
    expect(store.get().dj.iceInfo.coverage).toBe(7);
  });

  it('un periodo fuera de la serie 2023 se marca iceOutOfSeries (derivado, sincronico), nunca extrapola ni llama a la red', async () => {
    const getCellForPoint = vi.fn();
    const iceRepository = { hasPeriod: (p) => p === '2023-01', getCellForPoint };
    const djPanel = createDjPanel({
      store,
      audioEngine,
      powerRepository: { getMonthlyForPoint: () => new Promise(() => {}) },
      iceRepository
    });
    store.set({
      selectedPoint: { lat: 0, lon: 0 },
      confirmedPeriod: '2024-06',
      activeTab: 'dj'
    });
    djPanel.render(store.get());
    await Promise.resolve();

    expect(getCellForPoint).not.toHaveBeenCalled();
    // "fuera de serie" ya no se guarda en el store (se deriva en cada
    // render de iceRepository.hasPeriod): se verifica en el DOM, que es la
    // fuente de verdad real para esta decision.
    const dj = document.getElementById('dj-panel');
    const iceStatusEl = findInput(dj, 'dj-ice-status');
    expect(iceStatusEl.textContent).toBe(t('es', 'djIceOutOfSeries', { period: '2024-06' }));
    expect(store.get().dj.iceInfo).toBeNull();
  });

  it('expone ICE_EXPLORE_POINTS con exactamente 4 puntos reales documentados', () => {
    expect(ICE_EXPLORE_POINTS.map((p) => p.id)).toEqual(['arcticIce', 'arcticOcean', 'antarcticIce', 'antarcticOcean']);
  });

  it('los botones "explorar hemisferios" llaman a onExplorePoint con las coordenadas reales documentadas', () => {
    const onExplorePoint = vi.fn();
    const djPanel = createDjPanel({
      store,
      audioEngine,
      powerRepository: { getMonthlyForPoint: () => new Promise(() => {}) },
      iceRepository: { hasPeriod: () => false, getCellForPoint: async () => ({ ok: false, reason: 'out-of-series' }) },
      onExplorePoint
    });
    store.set({ activeTab: 'dj' });
    djPanel.render(store.get());

    const dj = document.getElementById('dj-panel');
    const buttons = collectByDataI18nPrefix(dj, 'djIceExplore', { tag: 'button' });
    expect(buttons.length).toBe(ICE_EXPLORE_POINTS.length);
    buttons[0].dispatch('click');
    expect(onExplorePoint).toHaveBeenCalledWith(ICE_EXPLORE_POINTS[0].lat, ICE_EXPLORE_POINTS[0].lon);
  });
});

describe('DJ panel: correccion de reentrancia ice/rain (queryKey + microtask, bug real)', () => {
  let store;
  let audioEngine;
  const PERIOD = '2023-12';
  const POINT_A = { lat: 75.19, lon: -133.67 };
  const POINT_B = { lat: -55.9, lon: -84.91 };
  const NEVER_RESOLVES_POWER = { getMonthlyForPoint: () => new Promise(() => {}) };

  beforeEach(() => {
    globalThis.document = buildFakeDocument();
    store = createStore(createInitialState({ lang: 'es' }));
    audioEngine = { Tone: createMockTone(), isStarted: () => true, getBus: () => ({}) };
  });

  it('REGRESION: elegir B (misma fecha) mientras A esta en vuelo nunca reinyecta/sobrescribe el hielo de A, ni mientras B pendiente ni si A resuelve tarde', async () => {
    let resolveA;
    let resolveB;
    const getCellForPoint = vi.fn((lat) => {
      if (lat === POINT_A.lat) return new Promise((resolve) => { resolveA = resolve; });
      return new Promise((resolve) => { resolveB = resolve; });
    });
    const iceRepository = { hasPeriod: () => true, getCellForPoint };
    const updateDataSpy = vi.spyOn(DjMixer.prototype, 'updateData');
    try {
      const djPanel = createDjPanel({ store, audioEngine, powerRepository: NEVER_RESOLVES_POWER, iceRepository });

      store.set({
        selectedPoint: POINT_A,
        confirmedPeriod: PERIOD,
        cell: { value: null },
        activeTab: 'dj',
        dj: { ...store.get().dj, playing: true }
      });
      djPanel.render(store.get());
      await Promise.resolve(); // deja arrancar el fetch de A (programado con queueMicrotask)

      // El usuario elige B ANTES de que A resuelva.
      store.set((s) => ({ selectedPoint: POINT_B }));
      djPanel.render(store.get());
      await Promise.resolve(); // deja arrancar el fetch de B

      // B sigue pendiente: el mezclador NUNCA debe tener el hielo de A
      // (ni siquiera transitoriamente), y el store no debe mostrar info
      // de ningun punto todavia.
      const lastWhilePending = updateDataSpy.mock.calls.at(-1)[0];
      expect(lastWhilePending.ice).toBeNull();
      expect(store.get().dj.iceInfo).toBeNull();

      // B resuelve primero.
      resolveB({
        ok: true,
        period: PERIOD,
        cell: { value: 0.33, index: 0 },
        dataset: { coverage: [11], version_hash: 'hash-b', dataset: 'NOAA/NSIDC G02135' }
      });
      await Promise.resolve();
      await Promise.resolve();
      djPanel.render(store.get());
      expect(store.get().dj.iceInfo.value).toBeCloseTo(0.33);

      // A resuelve TARDE (despues de B): nunca debe pisar el resultado de B.
      resolveA({
        ok: true,
        period: PERIOD,
        cell: { value: 1, index: 0 },
        dataset: { coverage: [21], version_hash: 'hash-a', dataset: 'NOAA/NSIDC G02135' }
      });
      await Promise.resolve();
      await Promise.resolve();
      djPanel.render(store.get());

      expect(store.get().dj.iceInfo.value).toBeCloseTo(0.33); // sigue siendo B, no el 1 de A
      const lastFinal = updateDataSpy.mock.calls.at(-1)[0];
      expect(lastFinal.ice).toBeCloseTo(0.33);
    } finally {
      updateDataSpy.mockRestore();
    }
  });

  it('REGRESION: cambiar de un periodo real (2023) a uno fuera de serie (2024) marca iceOutOfSeries y deja el mezclador con ice=null, incluso con la lluvia todavia pendiente', async () => {
    const getCellForPoint = vi.fn();
    const iceRepository = { hasPeriod: (p) => p === '2023-12', getCellForPoint };
    const updateDataSpy = vi.spyOn(DjMixer.prototype, 'updateData');
    try {
      const djPanel = createDjPanel({ store, audioEngine, powerRepository: NEVER_RESOLVES_POWER, iceRepository });

      store.set({
        selectedPoint: POINT_A,
        confirmedPeriod: '2024-01', // fuera de la serie 2023
        cell: { value: null },
        activeTab: 'dj',
        dj: { ...store.get().dj, playing: true }
      });
      djPanel.render(store.get());
      await Promise.resolve();
      await Promise.resolve();
      djPanel.render(store.get());

      const dj = document.getElementById('dj-panel');
      const iceStatusEl = findInput(dj, 'dj-ice-status');
      expect(iceStatusEl.textContent).toBe(t('es', 'djIceOutOfSeries', { period: '2024-01' }));
      expect(getCellForPoint).not.toHaveBeenCalled(); // fuera de serie nunca llega a pedir red
      const last = updateDataSpy.mock.calls.at(-1)[0];
      expect(last.ice).toBeNull();
      expect(last.rain).toBeNull(); // la lluvia sigue pendiente: tampoco se inventa un valor
    } finally {
      updateDataSpy.mockRestore();
    }
  });

  async function flushMicrotasks(times = 6) {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  it('REGRESION (store.subscribe real, no render() manual): A ya resuelto y sonando (ice=1); elegir B (mismo mes) pendiente nunca reintroduce 1 en ningun updateData posterior', async () => {
    const getCellForPoint = vi.fn((lat) => {
      if (lat === POINT_A.lat) {
        return Promise.resolve({
          ok: true,
          period: PERIOD,
          cell: { value: 1, index: 0 },
          dataset: { coverage: [21], version_hash: 'hash-a', dataset: 'NOAA/NSIDC G02135' }
        });
      }
      return new Promise(() => {}); // B nunca resuelve en este test
    });
    const iceRepository = { hasPeriod: () => true, getCellForPoint };
    const updateDataSpy = vi.spyOn(DjMixer.prototype, 'updateData');
    try {
      const djPanel = createDjPanel({ store, audioEngine, powerRepository: NEVER_RESOLVES_POWER, iceRepository });
      // store.subscribe real (igual que main.js): cada store.set, incluyendo
      // los que fetchIceFor hace internamente, dispara render() de verdad,
      // ejercitando el mismo camino de re-entrancia que en produccion.
      store.subscribe(djPanel.render);

      store.set({
        selectedPoint: POINT_A,
        confirmedPeriod: PERIOD,
        cell: { value: null },
        activeTab: 'dj',
        dj: { ...store.get().dj, playing: true }
      });
      await flushMicrotasks();

      expect(store.get().dj.iceInfo?.value).toBe(1);
      expect(updateDataSpy.mock.calls.at(-1)[0].ice).toBe(1);

      const callsBeforeB = updateDataSpy.mock.calls.length;
      store.set((s) => ({ selectedPoint: POINT_B }));
      // El MISMO render sincrono que procesa la seleccion de B ya debe
      // dejar el mezclador en ice=null (via iceValueForMixer local, gateado
      // por queryKey), sin esperar ningun microtask. dj.iceInfo en el store
      // puede seguir mostrando momentaneamente el valor viejo de A (su
      // limpieza esta deliberadamente diferida al microtask, ver render());
      // lo que NUNCA debe pasar es que ese valor viejo llegue al mezclador
      // o a la UI, que es justamente lo que se verifica aqui y abajo.
      expect(updateDataSpy.mock.calls.at(-1)[0].ice).toBeNull();
      const dj = document.getElementById('dj-panel');
      const iceStatusElNow = findInput(dj, 'dj-ice-status');
      expect(iceStatusElNow.textContent).not.toContain('98.0'); // no asoma el valor de A (1 -> "100.0")
      expect(iceStatusElNow.textContent).toBe(t('es', 'djIceLoading'));

      await flushMicrotasks(); // deja que el fetch de B arranque (sigue pendiente)

      const callsAfterB = updateDataSpy.mock.calls.slice(callsBeforeB);
      expect(callsAfterB.every((call) => call[0].ice !== 1)).toBe(true);
      expect(store.get().dj.iceInfo).toBeNull();
    } finally {
      updateDataSpy.mockRestore();
    }
  });

  it('REGRESION (store.subscribe real, lifecycle): A sonando con pad; elegir B pendiente + rerenders (setChannel misma config) mantienen la compuerta en 0 y no reinyectan la cola de A', async () => {
    const getCellForPoint = vi.fn((lat) =>
      lat === POINT_A.lat
        ? Promise.resolve({ ok: true, period: PERIOD, cell: { value: 1, index: 0 }, dataset: { coverage: [21], version_hash: 'hash-a', dataset: 'NOAA/NSIDC G02135' } })
        : new Promise(() => {})
    );
    const iceRepository = { hasPeriod: () => true, getCellForPoint };
    const updateDataSpy = vi.spyOn(DjMixer.prototype, 'updateData');
    try {
      const djPanel = createDjPanel({ store, audioEngine, powerRepository: NEVER_RESOLVES_POWER, iceRepository });
      store.subscribe(djPanel.render);
      store.set({
        selectedPoint: POINT_A,
        confirmedPeriod: PERIOD,
        cell: { value: null },
        activeTab: 'dj',
        dj: { ...store.get().dj, playing: true }
      });
      await flushMicrotasks();
      const mixer = updateDataSpy.mock.contexts[0];
      const stepCb = [...audioEngine.Tone.Transport._events.values()][0];
      stepCb(0);
      expect(mixer.nodes.pad.triggerAttackRelease).toHaveBeenCalledTimes(1);
      expect(mixer.gainState.ice).toBeGreaterThan(0);

      store.set(() => ({ selectedPoint: POINT_B }));
      await flushMicrotasks();
      for (let i = 0; i < 4; i += 1) {
        store.set((st) => ({ audio: { ...st.audio, volumeDb: -10 - i } }));
        await flushMicrotasks();
      }
      expect(mixer.gainState.ice).toBe(0);
      expect(mixer.latched.ice).toBe(true);
      for (let k = 1; k < 40; k += 1) stepCb(k * 0.15);
      expect(mixer.nodes.pad.triggerAttackRelease).toHaveBeenCalledTimes(1);
      expect(mixer.gainState.ice).toBe(0);
    } finally {
      updateDataSpy.mockRestore();
    }
  });

  it('REGRESION (store.subscribe real): periodo 2023 resuelto -> cambiar a 2024 (fuera de serie) actualiza DOM y mezclador de inmediato, sin bandera vieja', async () => {
    const getCellForPoint = vi.fn(() =>
      Promise.resolve({
        ok: true,
        period: PERIOD,
        cell: { value: 0.986, index: 0 },
        dataset: { coverage: [21], version_hash: 'hash-2023', dataset: 'NOAA/NSIDC G02135' }
      })
    );
    const iceRepository = { hasPeriod: (p) => p === PERIOD, getCellForPoint };
    const updateDataSpy = vi.spyOn(DjMixer.prototype, 'updateData');
    try {
      const djPanel = createDjPanel({ store, audioEngine, powerRepository: NEVER_RESOLVES_POWER, iceRepository });
      store.subscribe(djPanel.render);

      store.set({
        selectedPoint: POINT_A,
        confirmedPeriod: PERIOD,
        cell: { value: null },
        activeTab: 'dj',
        dj: { ...store.get().dj, playing: true }
      });
      await flushMicrotasks();
      expect(store.get().dj.iceInfo?.value).toBeCloseTo(0.986);
      expect(updateDataSpy.mock.calls.at(-1)[0].ice).toBeCloseTo(0.986);

      store.set({ confirmedPeriod: '2024-01' }); // fuera de la serie 2023
      // Derivado sincronico: el MISMO render ya debe mostrar "fuera de
      // serie" y ice=null, sin esperar ningun microtask ni mostrar el
      // 0.986 de 2023 ni un instante.
      expect(updateDataSpy.mock.calls.at(-1)[0].ice).toBeNull();
      const dj = document.getElementById('dj-panel');
      const iceStatusEl = findInput(dj, 'dj-ice-status');
      expect(iceStatusEl.textContent).toBe(t('es', 'djIceOutOfSeries', { period: '2024-01' }));

      await flushMicrotasks();
      expect(iceStatusEl.textContent).toBe(t('es', 'djIceOutOfSeries', { period: '2024-01' }));
      expect(updateDataSpy.mock.calls.at(-1)[0].ice).toBeNull();
    } finally {
      updateDataSpy.mockRestore();
    }
  });
});

describe('DJ panel: invalidacion al salir de la pestana DJ', () => {
  let store;
  let audioEngine;
  const PERIOD = '2023-12';
  const POINT_A = { lat: 75.19, lon: -133.67 };
  const NEVER_RESOLVES_POWER = { getMonthlyForPoint: () => new Promise(() => {}) };

  beforeEach(() => {
    globalThis.document = buildFakeDocument();
    store = createStore(createInitialState({ lang: 'es' }));
    audioEngine = { Tone: createMockTone(), isStarted: () => true, getBus: () => ({}) };
  });

  async function flushMicrotasks(times = 6) {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  it('REGRESION: una respuesta de hielo que llega DESPUES de salir de DJ nunca escribe en el store; volver a DJ con el MISMO punto+periodo vuelve a consultar', async () => {
    let resolveFirst;
    let callCount = 0;
    const getCellForPoint = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({
            ok: true,
            period: PERIOD,
            cell: { value: 0.5, index: 0 },
            dataset: { coverage: [10], version_hash: 'h1', dataset: 'NOAA/NSIDC G02135' }
          });
        });
      }
      return Promise.resolve({
        ok: true,
        period: PERIOD,
        cell: { value: 0.75, index: 0 },
        dataset: { coverage: [15], version_hash: 'h2', dataset: 'NOAA/NSIDC G02135' }
      });
    });
    const iceRepository = { hasPeriod: () => true, getCellForPoint };
    const djPanel = createDjPanel({ store, audioEngine, powerRepository: NEVER_RESOLVES_POWER, iceRepository });
    store.subscribe(djPanel.render);

    store.set({
      selectedPoint: POINT_A,
      confirmedPeriod: PERIOD,
      cell: { value: null },
      activeTab: 'dj',
      dj: { ...store.get().dj, playing: true }
    });
    await flushMicrotasks(); // arranca el primer fetch (queda pendiente, resolveFirst sin llamar)
    expect(getCellForPoint).toHaveBeenCalledTimes(1);

    // El usuario sale de DJ ANTES de que la primera solicitud resuelva.
    store.set({ activeTab: 'explore' });

    // Ahora SI resuelve (tarde, ya fuera de DJ): nunca debe escribir nada.
    resolveFirst();
    await flushMicrotasks();
    expect(store.get().dj.iceInfo).toBeNull();
    expect(store.get().dj.iceError).toBeNull();

    // El usuario vuelve a DJ con el MISMO punto+periodo: debe consultar
    // de nuevo (las claves se resetearon al salir), no quedarse "cargando"
    // para siempre por creer que ya se habia pedido.
    store.set({ activeTab: 'dj' });
    await flushMicrotasks();

    expect(getCellForPoint).toHaveBeenCalledTimes(2);
    expect(store.get().dj.iceInfo?.value).toBe(0.75);
  });
});

describe('DJ panel: composicion finita', () => {
  let store;
  let audioEngine;
  let djPanel;

  function setup() {
    globalThis.document = buildFakeDocument();
    store = createStore(createInitialState({ lang: 'es' }));
    audioEngine = { Tone: createMockTone(), isStarted: () => true, getBus: () => ({}) };
    djPanel = createDjPanel({ store, audioEngine, powerRepository: { getMonthlyForPoint: () => new Promise(() => {}) } });
    store.set({ selectedPoint: { lat: 1, lon: 1 }, confirmedPeriod: '2023-01', cell: { value: 7.82 }, activeTab: 'dj' });
    djPanel.render(store.get());
  }
  const btn = () => findInput(globalThis.document.getElementById('dj-panel'), 'dj-composition-btn');

  it('nunca arranca sola; el boton la inicia con Transport a 96 BPM y no activa el DJ continuo', () => {
    setup();
    expect(audioEngine.Tone.Transport.scheduleRepeat).not.toHaveBeenCalled();
    btn().dispatch('click');
    djPanel.render(store.get());
    expect(store.get().composition.playing).toBe(true);
    expect(store.get().dj.playing).toBe(false);
    expect(audioEngine.Tone.Transport.bpm.value).toBe(96);
    expect(audioEngine.Tone.Transport.scheduleRepeat).toHaveBeenCalledTimes(1);
    expect(btn().getAttribute('aria-pressed')).toBe('true');
  });

  it('mute y salir de la pestana DJ cancelan la composicion', () => {
    setup();
    btn().dispatch('click');
    djPanel.render(store.get());
    store.set({ audio: { ...store.get().audio, muted: true } });
    djPanel.render(store.get());
    expect(store.get().composition.playing).toBe(false);

    setup();
    btn().dispatch('click');
    djPanel.render(store.get());
    store.set({ activeTab: 'explore' });
    djPanel.render(store.get());
    expect(store.get().composition.playing).toBe(false);
  });

  it('al agotar los 128 pasos se marca ended y deja de estar playing', () => {
    setup();
    btn().dispatch('click');
    djPanel.render(store.get());
    const cb = [...audioEngine.Tone.Transport._events.values()][0];
    for (let i = 0; i <= 128; i += 1) cb(i * 0.15);
    expect(store.get().composition).toEqual({ playing: false, ended: true });
  });
});
