import { validateGistempDataset } from './validate.js';

const MAX_CACHE_ENTRIES = 5; // periodo actual + hasta 2 vecinos, con margen

/**
 * Cache LRU minima: al llegar al limite descarta la entrada usada hace mas
 * tiempo. Implementada sobre un Map (preserva orden de insercion/acceso).
 */
export class LruCache {
  constructor(maxSize = MAX_CACHE_ENTRIES) {
    this.maxSize = maxSize;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  get size() {
    return this.map.size;
  }
}

export function parsePeriod(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`Periodo invalido: ${period}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function formatPeriod(year, month) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function shiftPeriod(period, deltaMonths) {
  const { year, month } = parsePeriod(period);
  const zeroBased = (month - 1) + deltaMonths;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = ((zeroBased % 12) + 12) % 12 + 1;
  return formatPeriod(newYear, newMonth);
}

/**
 * Lista de periodos vecinos (hasta 2: anterior y siguiente) que realmente
 * existen en el manifiesto. Nunca se referencian periodos inexistentes.
 */
export function neighborPeriods(period, manifestPeriods) {
  const available = new Set(manifestPeriods);
  const neighbors = [];
  const prev = shiftPeriod(period, -1);
  const next = shiftPeriod(period, 1);
  if (available.has(prev)) neighbors.push(prev);
  if (available.has(next)) neighbors.push(next);
  return neighbors;
}

/**
 * Repositorio de datasets GISTEMP mensuales. Carga el periodo actual mas
 * como maximo 2 vecinos, con una cache LRU pequena y un numero de version
 * de solicitud: si llega una respuesta de una solicitud ya superada por una
 * mas reciente, se descarta en vez de pisar el estado actual con datos
 * viejos.
 */
// Fallback por defecto: NO se asigna `fetch` directamente (esa referencia,
// al invocarse mas tarde como this.fetchImpl(...), cambia el `this` dentro
// de la funcion nativa y el navegador lanza "TypeError: Failed to execute
// 'fetch' on 'Window': Illegal invocation"). Se envuelve en una arrow
// function que siempre llama a globalThis.fetch con el `this` correcto.
const defaultFetchImpl = (...args) => globalThis.fetch(...args);

export class GistempRepository {
  constructor({ fetchImpl = defaultFetchImpl, baseUrl = '', manifest, cache } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.manifest = manifest ?? { files: [] };
    this.cache = cache ?? new LruCache();
    this.pathByPeriod = new Map(
      (this.manifest.files ?? [])
        .filter((f) => typeof f.period === 'string' && typeof f.path === 'string')
        .map((f) => [f.period, f.path])
    );
    this.requestVersion = 0;
    this.inflight = new Map();
  }

  get availablePeriods() {
    return Array.from(this.pathByPeriod.keys()).sort();
  }

  hasPeriod(period) {
    return this.pathByPeriod.has(period);
  }

  // Solicitudes simultaneas del MISMO periodo comparten una sola descarga.
  fetchPeriod(period) {
    if (this.cache.has(period)) return Promise.resolve(this.cache.get(period));
    const shared = this.inflight.get(period);
    if (shared) return shared;
    const promise = (async () => {
      const path = this.pathByPeriod.get(period);
      if (!path) throw new Error(`Periodo no disponible en el manifiesto: ${period}`);
      const res = await this.fetchImpl(`${this.baseUrl}${path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} al cargar ${path}`);
      const json = await res.json();
      const validated = validateGistempDataset(json);
      this.cache.set(period, validated);
      return validated;
    })().finally(() => this.inflight.delete(period));
    this.inflight.set(period, promise);
    return promise;
  }

  /**
   * Carga el periodo solicitado y hasta 2 vecinos. Devuelve null si, para
   * cuando termina de resolver, ya se emitio una solicitud mas reciente
   * (evita aplicar una respuesta vieja fuera de orden).
   */
  async loadPeriod(period) {
    this.requestVersion += 1;
    const version = this.requestVersion;

    const neighbors = neighborPeriods(period, this.availablePeriods);
    const current = await this.fetchPeriod(period);

    if (version !== this.requestVersion) {
      return null; // una solicitud mas nueva ya la reemplazo
    }

    // Los vecinos se precargan en segundo plano para navegacion fluida,
    // pero no bloquean ni invalidan la respuesta del periodo pedido.
    for (const neighborPeriod of neighbors) {
      this.fetchPeriod(neighborPeriod).catch(() => {});
    }

    return { requestedPeriod: period, data: current, version };
  }
}
