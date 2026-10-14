// Logica pura de "Tu historia con la Tierra": validacion del mes/ano de
// nacimiento, diferencia de anomalias, busqueda de ciudad y lectura ATOMICA
// de las dos epocas (mismo punto, misma celda, misma fuente). Sin DOM ni Tone.
import { findNearestCell } from '../data/grid.js';
import { formatPeriod, parsePeriod } from '../data/repository.js';
import { t } from '../i18n/index.js';

export const MAX_RESULTS = 10;
export const MIN_QUERY_LENGTH = 2;

export function foldText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Busca en las filas compactas de GeoNames [id, nombre, pais, lat, lon,
 * poblacion, claves]. Orden: nombre exacto, prefijo del nombre, prefijo de
 * otra clave, subcadena; empates por poblacion (las filas ya vienen por
 * poblacion descendente). Devuelve como maximo `limit` filas y el total.
 */
export function searchCities(rows, query, limit = MAX_RESULTS) {
  const q = foldText(query);
  if (q.length < MIN_QUERY_LENGTH || !Array.isArray(rows)) return { items: [], total: 0 };
  const scored = [];
  for (let i = 0; i < rows.length; i += 1) {
    const keys = rows[i][6];
    if (!keys.includes(q)) continue;
    const list = keys.split('|');
    let score;
    if (list[0] === q) score = 0;
    else if (list[0].startsWith(q)) score = 1;
    else if (list.some((k) => k === q)) score = 1;
    else if (list.some((k) => k.startsWith(q))) score = 2;
    else score = 3;
    scored.push([score, i]);
  }
  scored.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return {
    items: scored.slice(0, limit).map(([, i]) => rows[i]),
    total: scored.length
  };
}

export function cityRowToPlace(row) {
  const [id, name, country, lat, lon] = row;
  return { id, name, country, lat, lon };
}

/**
 * Valida mes/ano de nacimiento contra los periodos REALES del manifiesto.
 * Nunca trata un campo vacio como 0 ni acepta fechas futuras.
 */
export function validateBirth({ year, month }, availablePeriods) {
  const yearText = String(year ?? '').trim();
  const monthText = String(month ?? '').trim();
  if (yearText === '' || monthText === '') return { ok: false, reason: 'empty' };
  if (!/^\d{4}$/.test(yearText) || !/^\d{1,2}$/.test(monthText)) return { ok: false, reason: 'invalid' };
  const y = Number(yearText);
  const m = Number(monthText);
  if (m < 1 || m > 12) return { ok: false, reason: 'invalid' };
  const periods = [...availablePeriods].sort();
  if (periods.length === 0) return { ok: false, reason: 'noSource' };
  const period = formatPeriod(y, m);
  if (period < periods[0]) return { ok: false, reason: 'beforeSource', min: periods[0] };
  const latest = periods[periods.length - 1];
  if (period > latest) return { ok: false, reason: 'afterLatest', max: latest };
  if (!periods.includes(period)) return { ok: false, reason: 'notAvailable' };
  return { ok: true, period };
}

export function validatePlace(place) {
  if (!place || typeof place !== 'object') return { ok: false, reason: 'noPlace' };
  const latOk = typeof place.lat === 'number' && Number.isFinite(place.lat) && place.lat >= -90 && place.lat <= 90;
  const lonOk = typeof place.lon === 'number' && Number.isFinite(place.lon) && place.lon >= -180 && place.lon <= 180;
  if (!latOk || !lonOk) return { ok: false, reason: 'noPlace' };
  return { ok: true };
}

/** Diferencia despues - antes en grados (delta de anomalia). null si falta alguno. */
export function computeDelta(before, after) {
  if (typeof before !== 'number' || typeof after !== 'number') return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return Number((after - before).toFixed(4));
}

export function formatDegrees(value, { signed = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  let text = Math.abs(value) < 0.005 ? '0.00' : value.toFixed(2);
  if (signed && value >= 0.005) text = `+${text}`;
  return text;
}

export function formatMonthYear(period, lang) {
  const { year, month } = parsePeriod(period);
  const name = new Intl.DateTimeFormat(lang === 'en' ? 'en' : 'es', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2001, month - 1, 1))
  );
  return lang === 'en' ? `${name} ${year}` : `${name} de ${year}`;
}

export function formatPlaceLabel(place, lang) {
  if (place.name) {
    let country = place.country ?? '';
    try {
      country = new Intl.DisplayNames([lang === 'en' ? 'en' : 'es'], { type: 'region' }).of(place.country) ?? country;
    } catch {
      // codigo de pais no reconocido: se muestra tal cual
    }
    return country ? `${place.name}, ${country}` : place.name;
  }
  return formatCoords(place.lat, place.lon);
}

export function formatCoords(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

function baselineLabel(baseline) {
  return String(baseline ?? '').replace('-', '–');
}

/**
 * Relato en texto claro. Solo anomalias mensuales respecto a la linea base;
 * nunca temperatura absoluta, porcentajes ni causas. Si falta un dato, lo
 * dice y no calcula diferencia.
 */
export function buildStory(result, lang, { latestPeriod } = {}) {
  const { a, b, delta, baseline } = result;
  const monthA = formatMonthYear(a.period, lang);
  const monthB = formatMonthYear(b.period, lang);
  const lines = [];
  const bLabel = t(lang, b.period === latestPeriod ? 'historyBLatest' : 'historyBOther', { period: monthB });
  if (a.value === null) {
    lines.push(t(lang, 'historyStoryMissingA', { period: monthA }));
  } else {
    lines.push(t(lang, 'historyStoryA', { period: monthA, x: formatDegrees(a.value, { signed: true }), baseline: baselineLabel(baseline) }));
  }
  if (b.value === null) {
    lines.push(t(lang, 'historyStoryMissingB', { period: monthB }));
  } else {
    lines.push(t(lang, 'historyStoryB', { bLabel, y: formatDegrees(b.value, { signed: true }) }));
  }
  if (delta === null) {
    lines.push(t(lang, 'historyStoryNoDelta'));
  } else if (a.period === b.period) {
    lines.push(t(lang, 'historyStorySame', { d: formatDegrees(delta, { signed: true }) }));
  } else {
    lines.push(t(lang, 'historyStoryDelta', { d: formatDegrees(delta, { signed: true }) }));
  }
  lines.push(t(lang, 'historyCaveat', { km: result.smoothingKm, deg: result.gridDeg }));
  return lines;
}

export function epochAnnouncement(result, which, lang) {
  const epoch = result[which];
  const period = formatMonthYear(epoch.period, lang);
  if (epoch.value === null) return t(lang, 'historyAnnounceNoData', { period });
  return t(lang, which === 'a' ? 'historyAnnounceA' : 'historyAnnounceB', {
    period,
    x: formatDegrees(epoch.value, { signed: true })
  });
}

/**
 * Lee las dos epocas y confirma la comparacion como un UNICO resultado
 * atomico: ambos datasets deben compartir rejilla, celda y fuente. Usa
 * fetchPeriod del repositorio (no loadPeriod), asi no compite con la
 * solicitud del globo ni precarga vecinos. Devuelve
 * { ok: true, result } | { ok: false, reason }.
 */
export async function loadHistoryResult({ repository, point, periodA, periodB, placeLabel = null }) {
  let datasets;
  try {
    const unique = [...new Set([periodA, periodB])];
    const loaded = await Promise.all(unique.map((p) => repository.fetchPeriod(p)));
    datasets = new Map(unique.map((p, i) => [p, loaded[i]]));
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }
  const dsA = datasets.get(periodA);
  const dsB = datasets.get(periodB);
  let cellA;
  let cellB;
  try {
    cellA = findNearestCell(point.lat, point.lon, dsA);
    cellB = findNearestCell(point.lat, point.lon, dsB);
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }
  if (cellA.latIdx !== cellB.latIdx || cellA.lonIdx !== cellB.lonIdx) return { ok: false, reason: 'gridMismatch' };
  const shaA = dsA.source?.original_file_sha256 ?? null;
  const shaB = dsB.source?.original_file_sha256 ?? null;
  if (shaA !== shaB || dsA.baseline_period !== dsB.baseline_period || dsA.units !== dsB.units) {
    return { ok: false, reason: 'sourceMismatch' };
  }
  const valueA = typeof cellA.value === 'number' ? cellA.value : null;
  const valueB = typeof cellB.value === 'number' ? cellB.value : null;
  return {
    ok: true,
    result: {
      key: `${point.lat}:${point.lon}:${periodA}:${periodB}`,
      point: { lat: point.lat, lon: point.lon },
      placeLabel,
      cell: { latIdx: cellA.latIdx, lonIdx: cellA.lonIdx, latCenter: cellA.latCenter, lonCenter: cellA.lonCenter },
      a: { period: periodA, value: valueA },
      b: { period: periodB, value: valueB },
      delta: computeDelta(valueA, valueB),
      baseline: dsA.baseline_period,
      units: dsA.units,
      smoothingKm: dsA.smoothing_radius_km,
      gridDeg: dsA.grid_resolution_deg,
      dataset: dsA.dataset ?? null,
      sourceSha: shaA
    }
  };
}
