// Prueba de integracion (sin jsdom: un DOM minimo hecho a mano, suficiente
// para los elementos que timeline.js y accessible-panel.js realmente tocan)
// para el recorrido que fallaba en navegador real:
//
//   Desde Accesible, consultar Iquitos (-3.75,-73.25) en 2023-01 debia
//   actualizar period-status A 2023-01 pero los selects de ano/mes/rango
//   GLOBALES quedaban en el periodo anterior, y #acc-result no mostraba
//   ningun valor hasta pulsar "Describir".
//
// Esta prueba reproduce ese flujo con los modulos reales (createTimeline +
// createAccessiblePanel + createStore) y verifica que, tras resolver
// onQuery, AMBOS quedan sincronizados sin pulsar nada mas.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStore, createInitialState } from '../src/state/store.js';
import { createTimeline } from '../src/ui/timeline.js';
import { createAccessiblePanel } from '../src/ui/accessible-panel.js';

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
    'year-select',
    'month-select',
    'year-range',
    'play-pause-btn',
    'period-status',
    'period-retry-btn',
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

describe('Integracion: sincronizacion de periodo tras consulta Accesible', () => {
  let fakeDocument;
  let registry;
  let store;

  beforeEach(() => {
    ({ fakeDocument, registry } = buildFakeDom());
    globalThis.document = fakeDocument;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ sites: [] }) }));
    globalThis.window = globalThis.window ?? {};
    store = createStore(createInitialState({ lang: 'es' }));
  });

  it('confirmar un periodo via Accesible sincroniza year/month/range Y el texto de acc-description, sin pulsar Describir', async () => {
    const availablePeriods = ['2022-12', '2023-01', '2025-12'];
    const timeline = createTimeline({
      store,
      availablePeriods,
      onPeriodChange: (period) => changePeriod(period),
      onTogglePlay: () => {}
    });
    timeline.setPeriodSelects('2025-12');

    // Simula el repositorio/changePeriod de main.js: confirma dataset +
    // periodo + celda en UN solo store.set (igual que main.js real).
    async function changePeriod(period) {
      const dataset = {
        period,
        units: 'K',
        baseline_period: '1951-1980',
        grid_resolution_deg: 2,
        smoothing_radius_km: 1200,
        axes: { lat_centers: [-3.75], lon_centers: [-73.25] },
        values: [1.23]
      };
      store.set({ confirmedPeriod: period, dataset, periodError: null });
    }

    const accessiblePanel = createAccessiblePanel({
      store,
      repository: { availablePeriods },
      narrator: { speak: vi.fn(), cancel: vi.fn() },
      onQuery: async ({ lat, lon, period }) => {
        if (period) await changePeriod(period);
        store.set({ selectedPoint: { lat, lon }, cell: { latIdx: 0, lonIdx: 0, value: 1.23 } });
      },
      onDescribe: () => 'no-deberia-usarse-en-esta-prueba',
      onListen: () => {},
      onCompareA: () => {},
      onCompareB: () => {}
    });

    store.subscribe((state) => {
      timeline.render(state);
      accessiblePanel.render(state);
    });
    timeline.render(store.get());
    accessiblePanel.render(store.get());

    // Simula: escribir lat/lon, elegir periodo 2023-01 en el select accesible y enviar.
    registry.get('acc-lat').value = '-3.75';
    registry.get('acc-lon').value = '-73.25';
    registry.get('acc-period').value = '2023-01';

    const form = registry.get('accessible-form');
    form.dispatch('submit', { preventDefault: () => {} });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 1) year/month/range globales deben reflejar 2023-01, NO quedarse en 2025-12.
    expect(registry.get('year-select').value).toBe('2023');
    expect(registry.get('month-select').value).toBe('01');

    // 2) acc-description debe mostrar el dato SIN haber pulsado "Describir".
    const description = registry.get('acc-description').textContent;
    expect(description).toContain('2023-01');
    expect(description).not.toBe('');
    expect(description).not.toBe('no-deberia-usarse-en-esta-prueba');
  });
});
