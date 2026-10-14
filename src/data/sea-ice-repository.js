// Repositorio de hielo marino NOAA/NSIDC G02135 (ver
// scripts/prepare_sea_ice_g02135.py). A diferencia de la lluvia (NASA
// POWER, por punto/en vivo), el hielo es una REJILLA mensual estatica
// pre-generada (igual forma que GISTEMP: misma rejilla de 2 grados, mismos
// axes lat_centers/lon_centers, ver docs/pending-data-research.md), asi que
// este repositorio reutiliza findNearestCell (data/grid.js) directamente
// para el lookup 2 grados alineado con GISTEMP, en vez de reimplementarlo.
//
// Serie disponible: 2023 completo (12 meses, norte+sur emparejados, ver
// public/data/sea-ice-g02135/). Un periodo FUERA de esa serie (otro anio,
// u otro mes sin par norte/sur real) NUNCA se extrapola ni se rellena con
// 0: se reporta explicitamente como "sin dato para este periodo" (ver
// getCellForPoint -> { ok: false, reason: 'out-of-series' }).
//
// Reglas de robustez explicitas (mismo espiritu que data/repository.js y
// data/power-repository.js):
//  - Cache LRU acotada (12 entradas, reutiliza LruCache de repository.js:
//    la serie 2023 completa son exactamente 12 periodos, asi que en el
//    uso normal todo cabe, pero nunca crece sin limite).
//  - "Bounded cancel guard" CORREGIDO: requestVersion se incrementa SIEMPRE
//    como primer paso de getCellForPoint, incluso para un periodo
//    fuera de serie (antes se incrementaba DESPUES de ese caso temprano:
//    una solicitud 2023 en vuelo no quedaba invalidada por una seleccion
//    2024 posterior, porque esa segunda llamada nunca avanzaba el
//    contador. Ver docs/pending-data-research.md / notas de revision).
//    Toda llamada (exitosa, fuera de serie, o con error) consume un
//    numero de version, asi que cualquier llamada ANTERIOR que resuelva
//    despues queda correctamente marcada 'stale'.
//  - Timeout acotado (9s) con AbortController por solicitud de red real;
//    el timer se limpia siempre en `finally` (nunca queda un timer vivo
//    tras resolver/abortar).
//  - Coalescencia: dos llamadas concurrentes al MISMO periodo comparten la
//    misma promesa de red en vuelo en vez de disparar una segunda
//    solicitud duplicada.
//  - Un JSON mal formado (ver validateSeaIceDataset) se rechaza con un
//    error explicito, nunca se acepta a medias.

import { validateSeaIceDataset } from './validate.js';
import { findNearestCell } from './grid.js';
import { LruCache } from './repository.js';

const MAX_CACHE_ENTRIES = 12; // la serie 2023 completa son exactamente 12 periodos
const FETCH_TIMEOUT_MS = 9000;

const defaultFetchImpl = (...args) => globalThis.fetch(...args);

export class IceRepository {
  constructor({ fetchImpl = defaultFetchImpl, baseUrl = '', periods = [], fetchTimeoutMs = FETCH_TIMEOUT_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.periods = new Set(periods);
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.cache = new LruCache(MAX_CACHE_ENTRIES); // period -> dataset validado
    this.inFlight = new Map(); // period -> Promise<dataset> ya en curso (coalescencia)
    this.requestVersion = 0;
  }

  get availablePeriods() {
    return Array.from(this.periods).sort();
  }

  hasPeriod(period) {
    return this.periods.has(period);
  }

  /**
   * Descarga y valida un periodo, con timeout acotado y coalescencia de
   * solicitudes concurrentes al mismo periodo. Lanza (nunca devuelve un
   * valor "a medias") si falla la red, el timeout, o la validacion.
   */
  async fetchPeriod(period) {
    if (this.cache.has(period)) return this.cache.get(period);
    if (!this.hasPeriod(period)) {
      throw new Error(`Periodo fuera de la serie de hielo disponible: ${period}`);
    }
    if (this.inFlight.has(period)) return this.inFlight.get(period);

    const promise = this._fetchPeriodUncached(period).finally(() => {
      this.inFlight.delete(period);
    });
    this.inFlight.set(period, promise);
    return promise;
  }

  async _fetchPeriodUncached(period) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}sea-ice-g02135/${period}.json`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} al cargar hielo ${period}`);
      const json = await res.json();
      const validated = validateSeaIceDataset(json);
      this.cache.set(period, validated);
      return validated;
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`Tiempo de espera agotado (${this.fetchTimeoutMs}ms) al cargar hielo ${period}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Carga el periodo pedido y busca la celda mas cercana a (lat, lon),
   * reutilizando findNearestCell (misma rejilla de 2 grados que GISTEMP).
   * Nunca lanza: siempre devuelve un resultado explicito.
   *  - { ok: false, reason: 'out-of-series' }: el periodo no esta en la
   *    serie 2023 disponible; NO es un error de red, es "sin dato real
   *    para este periodo", nunca se extrapola.
   *  - { ok: false, reason: 'error', detail }: fallo de red/timeout/validacion.
   *  - { ok: false, reason: 'stale' }: una llamada mas reciente ya
   *    reemplazo esta (bounded cancel guard).
   *  - { ok: true, period, cell, dataset }: cell.value es la fraccion
   *    0.0-1.0 o null (sin pixel oceanico valido en esa celda/periodo,
   *    NUNCA 0 por defecto).
   */
  async getCellForPoint(lat, lon, period) {
    // CRITICO: se incrementa SIEMPRE primero, incluso para el caso fuera
    // de serie (ver cabecera del modulo): de lo contrario una llamada
    // posterior "fuera de serie" no invalida una llamada anterior todavia
    // en vuelo, y esta ultima puede resolver tarde y pisar un estado mas
    // nuevo (regresion real detectada: pedir 2023 -> cambiar a 2024 -> el
    // 2023 diferido llegaba igual).
    this.requestVersion += 1;
    const version = this.requestVersion;

    if (!this.hasPeriod(period)) {
      return { ok: false, reason: 'out-of-series', period };
    }
    let dataset;
    try {
      dataset = await this.fetchPeriod(period);
    } catch (err) {
      if (version !== this.requestVersion) return { ok: false, reason: 'stale' };
      return { ok: false, reason: 'error', detail: String(err?.message ?? err) };
    }
    if (version !== this.requestVersion) return { ok: false, reason: 'stale' };
    const cell = findNearestCell(lat, lon, dataset);
    return { ok: true, period, cell, dataset };
  }
}
