import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateLatLon, describeState, createAccessiblePanel } from '../src/ui/accessible-panel.js';
import { createStore, createInitialState } from '../src/state/store.js';

describe('validateLatLon', () => {
  it('acepta coordenadas dentro de rango', () => {
    expect(validateLatLon(0, 0)).toEqual({ valid: true, errors: [] });
    expect(validateLatLon(-90, -180)).toEqual({ valid: true, errors: [] });
    expect(validateLatLon(90, 180)).toEqual({ valid: true, errors: [] });
  });

  it('rechaza (no satura) latitud fuera de [-90, 90]', () => {
    const result = validateLatLon(91, 0);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('lat');
  });

  it('rechaza longitud fuera de [-180, 180]', () => {
    const result = validateLatLon(0, 181);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('lon');
  });

  it('rechaza valores no numericos/NaN en vez de aceptarlos', () => {
    expect(validateLatLon(NaN, 0).valid).toBe(false);
    expect(validateLatLon(0, NaN).valid).toBe(false);
  });
});

describe('describeState', () => {
  const dataset = {
    period: '2023-01',
    units: 'K',
    baseline_period: '1951-1980'
  };

  it('sin punto seleccionado, devuelve el mensaje de "sin seleccion"', () => {
    const text = describeState({ lang: 'es', selectedPoint: null, cell: null, dataset: null, audio: null });
    expect(text.length).toBeGreaterThan(0);
  });

  it('diferencia celda sin dato (null) de una celda con valor 0 (dato real, anomalia nula)', () => {
    const base = {
      lang: 'es',
      selectedPoint: { lat: 1, lon: 2 },
      dataset,
      audio: { started: true, muted: false }
    };
    const missing = describeState({ ...base, cell: { value: null } });
    const zero = describeState({ ...base, cell: { value: 0 } });
    expect(missing).not.toEqual(zero);
    expect(missing).not.toContain('0.00');
    expect(zero).toContain('0.00');
  });

  it('diferencia silencio elegido (mute) de sonido activo o inactivo', () => {
    const base = { lang: 'es', selectedPoint: { lat: 1, lon: 2 }, dataset, cell: { value: 1 } };
    const muted = describeState({ ...base, audio: { started: true, muted: true } });
    const active = describeState({ ...base, audio: { started: true, muted: false } });
    const inactive = describeState({ ...base, audio: { started: false, muted: false } });
    expect(muted).not.toEqual(active);
    expect(muted).not.toEqual(inactive);
    expect(active).not.toEqual(inactive);
  });

  it('en ingles produce un texto distinto (idioma del documento cambia completo)', () => {
    const base = {
      selectedPoint: { lat: 1, lon: 2 },
      dataset,
      cell: { value: 1.23 },
      audio: { started: true, muted: false }
    };
    const es = describeState({ ...base, lang: 'es' });
    const en = describeState({ ...base, lang: 'en' });
    expect(es).not.toEqual(en);
  });
});

// DOM minimo hecho a mano (sin jsdom, igual que integration-accessible-sync.test.js).
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
    this.checked = false;
    this.className = '';
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
  querySelector() {
    return null;
  }
}

function buildFakeDom() {
  const registry = new Map();
  const ids = [
    'accessible-form',
    'acc-lat',
    'acc-lon',
    'acc-period',
    'acc-form-error',
    'acc-description',
    'acc-listen-btn',
    'acc-describe-btn',
    'acc-compare-a-btn',
    'acc-compare-b-btn',
    'acc-compare-result',
    'acc-places-list',
    'acc-narration-auto'
  ];
  for (const id of ids) registry.set(id, new FakeElement());
  const fakeDocument = {
    getElementById: (id) => registry.get(id) ?? null,
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: () => []
  };
  return { fakeDocument, registry };
}

describe('Formulario accesible: coordenadas vacias se rechazan (no se tratan como 0)', () => {
  let fakeDocument;
  let registry;
  let store;
  let onQuery;

  beforeEach(() => {
    ({ fakeDocument, registry } = buildFakeDom());
    globalThis.document = fakeDocument;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ sites: [] }) }));
    store = createStore(createInitialState({ lang: 'es' }));
    onQuery = vi.fn();
  });

  function submitForm() {
    const form = registry.get('accessible-form');
    form.dispatch('submit', { preventDefault: () => {} });
  }

  it('ambas coordenadas vacias: se rechaza con error, onQuery nunca se llama (Number("") no debe colarse como 0,0)', () => {
    createAccessiblePanel({
      store,
      repository: { availablePeriods: [] },
      narrator: { speak: vi.fn(), cancel: vi.fn(), isSpeaking: () => false },
      onQuery,
      onDescribe: () => '',
      onListen: () => {},
      onCompareA: () => {},
      onCompareB: () => {}
    });
    registry.get('acc-lat').value = '';
    registry.get('acc-lon').value = '';
    submitForm();
    expect(onQuery).not.toHaveBeenCalled();
    expect(registry.get('acc-form-error').textContent).not.toBe('');
  });

  it('una sola coordenada vacia (lon): tambien se rechaza, no se asume lon=0', () => {
    createAccessiblePanel({
      store,
      repository: { availablePeriods: [] },
      narrator: { speak: vi.fn(), cancel: vi.fn(), isSpeaking: () => false },
      onQuery,
      onDescribe: () => '',
      onListen: () => {},
      onCompareA: () => {},
      onCompareB: () => {}
    });
    registry.get('acc-lat').value = '-3.75';
    registry.get('acc-lon').value = '';
    submitForm();
    expect(onQuery).not.toHaveBeenCalled();
    expect(registry.get('acc-form-error').textContent).not.toBe('');
  });

  it('ambas coordenadas con valores reales (incluyendo 0,0 explicito escrito): SI se acepta', () => {
    createAccessiblePanel({
      store,
      repository: { availablePeriods: [] },
      narrator: { speak: vi.fn(), cancel: vi.fn(), isSpeaking: () => false },
      onQuery,
      onDescribe: () => '',
      onListen: () => {},
      onCompareA: () => {},
      onCompareB: () => {}
    });
    registry.get('acc-lat').value = '0';
    registry.get('acc-lon').value = '0';
    submitForm();
    expect(onQuery).toHaveBeenCalledWith({ lat: 0, lon: 0, period: undefined });
  });
});
