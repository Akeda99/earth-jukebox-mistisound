// Repositorio de precipitacion NASA POWER (PRECTOTCORR, reanalisis MERRA-2,
// mensual por punto). Dos fuentes, nunca mezcladas sin marcar cual es cual:
//
//  1. Los 3 puntos de Peru precargados en public/data/power/*.json
//     (ver docs/power-data.md). Coincidencia por coordenadas EXACTA dentro
//     de un epsilon pequenio (no se le atribuye a un punto el dato de otro).
//  2. Para cualquier otro punto del globo, consulta en vivo al endpoint
//     publico de NASA POWER (temporal/monthly/point), SOLO cuando el
//     usuario lo pide explicitamente (seleccion en modo DJ), nunca al
//     mover la camara ni antes de una accion del usuario.
//
// Reglas de robustez explicitas:
//  - Como maximo 1 solicitud en vuelo a la API en vivo: una nueva solicitud
//    cancela (AbortController) la anterior en vez de dejarlas competir.
//  - Timeout + reintentos limitados (solo errores transitorios).
//  - Cache acotada por celda efectiva aproximada (lat/lon redondeados) + anio.
//  - Si CORS/red falla, se informa un error explicito; NUNCA se inventa un
//    valor de reemplazo ni se finge una respuesta.
//  - header.fill_value (-999) -> null; se excluye SIEMPRE la clave anual
//    `YYYY13`; se verifica que las unidades declaradas sean "mm/day".

const POWER_API_BASE = 'https://power.larc.nasa.gov/api/temporal/monthly/point';
// Coincidencia con los 3 puntos locales: tolerancia MINIMA (solo redondeo
// flotante de la propia constante guardada), no un radio geografico. Un
// epsilon mayor (p.ej. grados enteros de margen) podria cruzar la frontera
// de celda MERRA-2 real y atribuirle a un punto cercano el archivo de otro
// (ver review: esto se revirtio explicitamente de un valor mayor).
const LOCAL_MATCH_EPSILON_DEG = 1e-6;
// Precision de consulta/cache: redondea UNA sola vez y usa ese mismo valor
// tanto para la clave de cache como para la URL real de la API, para que
// nunca se sirva desde cache la respuesta de una coordenada distinta de la
// que de verdad se le pidio a la API. ~11 m de tolerancia (4 decimales): una
// decision de UX para no repetir solicitudes por temblores de precision de
// punto flotante, no una afirmacion sobre la resolucion de la rejilla
// MERRA-2 (0.5x0.625 grados, ver docs/power-data.md).
const QUERY_PRECISION_DECIMALS = 4;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1500;
const MAX_CACHE_ENTRIES = 12;

const defaultFetchImpl = (...args) => globalThis.fetch(...args);

function roundQueryCoord(value) {
  const factor = 10 ** QUERY_PRECISION_DECIMALS;
  return Math.round(value * factor) / factor;
}

function cacheKey(lat, lon, year) {
  return `${lat}:${lon}:${year}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MONTH_KEY_RE = /^(\d{4})(0[1-9]|1[0-2]|13)$/;

/**
 * Convierte la respuesta cruda de la API (claves "YYYYMM" -> valor) a un
 * mapa "YYYY-MM" -> numero|null, excluyendo SIEMPRE la clave de promedio
 * anual "YYYY13". Rechaza (lanza) si faltan las unidades declaradas o si
 * encuentra una clave/valor que no se puede interpretar con confianza: NUNCA
 * se asume una unidad por defecto ni se descarta en silencio un dato
 * sospechoso (eso ocultaria un cambio de formato de la API).
 */
export function parsePowerApiResponse(json, { year } = {}) {
  const units = json?.parameters?.PRECTOTCORR?.units;
  if (typeof units !== 'string' || units.length === 0) {
    throw new Error('Respuesta de NASA POWER sin unidades declaradas (parameters.PRECTOTCORR.units)');
  }
  const fillValue = json?.header?.fill_value;
  const series = json?.properties?.parameter?.PRECTOTCORR;
  if (!series || typeof series !== 'object') {
    throw new Error('Respuesta de NASA POWER sin serie PRECTOTCORR');
  }
  const monthly = {};
  for (const [key, value] of Object.entries(series)) {
    const match = MONTH_KEY_RE.exec(key);
    if (!match) throw new Error(`Clave mensual inesperada en respuesta de NASA POWER: "${key}"`);
    const [, yyyy, month] = match;
    if (month === '13') continue; // promedio anual, nunca se presenta como mes
    if (value !== fillValue && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`Valor no numerico/no finito para ${key} en respuesta de NASA POWER`);
    }
    monthly[`${yyyy}-${month}`] = value === fillValue ? null : value;
  }
  return {
    monthly,
    units,
    // Coordenadas que la propia respuesta "geometry" reporta: pueden ser el
    // punto pedido ecoeado tal cual, NO necesariamente el centro de la celda
    // MERRA-2 resuelta (la API no publica ese centro en este endpoint). Se
    // muestran como "coordenadas reportadas", nunca como "centro de celda".
    coordsReported: {
      lon: json?.geometry?.coordinates?.[0] ?? null,
      lat: json?.geometry?.coordinates?.[1] ?? null,
      elevation_m: json?.geometry?.coordinates?.[2] ?? null
    },
    source: {
      service_name: 'NASA POWER (Prediction Of Worldwide Energy Resource)',
      product: json?.header?.sources?.join?.(', ') ?? 'MERRA2',
      service_version: json?.header?.api?.version ?? null,
      api_url: json?.header?.api?.url ?? null
    },
    requestedYear: year
  };
}

export class PowerRepository {
  constructor({
    fetchImpl = defaultFetchImpl,
    baseUrl = '',
    apiBase = POWER_API_BASE,
    maxRetries = MAX_RETRIES,
    retryBackoffMs = RETRY_BACKOFF_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.apiBase = apiBase;
    this.maxRetries = maxRetries;
    this.retryBackoffMs = retryBackoffMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.index = null;
    this.localCache = new Map(); // location_id -> dataset local ya cargado
    this.apiCache = new Map(); // cacheKey -> dataset remoto
    this.pendingController = null;
  }

  async loadIndex() {
    if (this.index) return this.index;
    const res = await this.fetchImpl(`${this.baseUrl}power-index.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} al cargar power-index.json`);
    this.index = await res.json();
    return this.index;
  }

  /** Busca si (lat, lon) coincide con uno de los 3 puntos locales precargados. */
  findLocalLocation(lat, lon) {
    if (!this.index) return null;
    for (const loc of this.index.locations ?? []) {
      const dLat = Math.abs(loc.coords_requested.lat - lat);
      const dLon = Math.abs(loc.coords_requested.lon - lon);
      if (dLat <= LOCAL_MATCH_EPSILON_DEG && dLon <= LOCAL_MATCH_EPSILON_DEG) {
        return loc;
      }
    }
    return null;
  }

  async loadLocalLocation(loc) {
    if (this.localCache.has(loc.id)) return this.localCache.get(loc.id);
    const res = await this.fetchImpl(`${this.baseUrl}${loc.path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} al cargar ${loc.path}`);
    const json = await res.json();
    this.localCache.set(loc.id, json);
    return json;
  }

  /** Cancela la solicitud en vivo pendiente, si hay alguna. */
  cancelPending() {
    if (this.pendingController) {
      this.pendingController.abort();
      this.pendingController = null;
    }
  }

  /**
   * Resuelve precipitacion mensual para (lat, lon). Devuelve
   * { ok: true, source: 'local'|'api', dataVersion, units, monthly, ... }
   * o { ok: false, error, reason } si falla (red/CORS/HTTP), SIN inventar
   * datos de relleno.
   */
  async getMonthlyForPoint(lat, lon, { year } = {}) {
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      return { ok: false, error: 'invalid-coords', field: 'lat' };
    }
    if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return { ok: false, error: 'invalid-coords', field: 'lon' };
    }

    await this.loadIndex().catch(() => {
      this.index = this.index ?? { locations: [] };
    });

    const local = this.findLocalLocation(lat, lon);
    if (local) {
      // Un punto local precargado reemplaza cualquier consulta en vivo que
      // hubiera quedado pendiente (nunca deben competir ni dejar que una
      // respuesta en vuelo de otra coordenada pise este resultado local).
      this.cancelPending();
      try {
        const data = await this.loadLocalLocation(local);
        return {
          ok: true,
          source: 'local',
          locationId: local.id,
          name: local.name,
          dataVersion: this.index?.data_version ?? data.data_version ?? null,
          units: data.units,
          coordsReported: data.coords_effective,
          sourceInfo: data.source,
          monthly: data.monthly,
          periodStart: data.period_start,
          periodEnd: data.period_end
        };
      } catch (err) {
        return { ok: false, error: 'local-load-failed', reason: String(err?.message ?? err) };
      }
    }

    if (!year || !Number.isInteger(year) || year < 1981 || year > 2100) {
      return { ok: false, error: 'invalid-year' };
    }

    return this._fetchLive(lat, lon, year);
  }

  async _fetchLive(lat, lon, year) {
    // Redondeado UNA sola vez: la misma coordenada se usa para la clave de
    // cache y para la URL real de la API (ver nota de QUERY_PRECISION_DECIMALS
    // arriba); evita que la cache sirva la respuesta de una coordenada
    // distinta de la que realmente se le pidio a NASA POWER.
    const queryLat = roundQueryCoord(lat);
    const queryLon = roundQueryCoord(lon);
    const key = cacheKey(queryLat, queryLon, year);
    if (this.apiCache.has(key)) return this.apiCache.get(key);

    // Maximo 1 solicitud pendiente: cualquier solicitud anterior se cancela.
    this.cancelPending();
    const controller = new AbortController();
    this.pendingController = controller;
    const timeoutHandle = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const url = `${this.apiBase}?parameters=PRECTOTCORR&community=RE&longitude=${queryLon}&latitude=${queryLat}&start=${year}&end=${year}&format=JSON`;

    let lastError = null;
    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        try {
          const res = await this.fetchImpl(url, { signal: controller.signal });
          if (!res.ok) {
            if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
              await sleep(this.retryBackoffMs);
              continue;
            }
            return { ok: false, error: 'http-error', status: res.status };
          }
          const json = await res.json();
          const parsed = parsePowerApiResponse(json, { year });
          if (parsed.units !== 'mm/day') {
            return { ok: false, error: 'unexpected-units', units: parsed.units };
          }
          const result = {
            ok: true,
            source: 'api',
            dataVersion: null, // la API en vivo no publica un data_version propio, a diferencia del indice local
            units: parsed.units,
            coordsReported: parsed.coordsReported,
            sourceInfo: parsed.source,
            monthly: parsed.monthly,
            periodStart: `${year}-01`,
            periodEnd: `${year}-12`
          };
          this.apiCache.set(key, result);
          while (this.apiCache.size > MAX_CACHE_ENTRIES) {
            this.apiCache.delete(this.apiCache.keys().next().value);
          }
          return result;
        } catch (err) {
          lastError = err;
          if (err?.name === 'AbortError') {
            return { ok: false, error: 'aborted' };
          }
          if (attempt < this.maxRetries) {
            await sleep(this.retryBackoffMs);
            continue;
          }
        }
      }
      return { ok: false, error: 'network-error', reason: String(lastError?.message ?? lastError) };
    } finally {
      clearTimeout(timeoutHandle);
      if (this.pendingController === controller) this.pendingController = null;
    }
  }
}
