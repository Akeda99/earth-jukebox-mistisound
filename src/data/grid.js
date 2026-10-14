// Logica pura de rejilla: validacion de ejes y busqueda de la celda mas
// cercana a un punto lat/lon, incluyendo los casos limite de polos y
// antimeridiano. Sin dependencias de Cesium ni del DOM para poder probarse
// con Vitest en Node.

export function isAscending(values) {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] <= values[i - 1]) return false;
  }
  return true;
}

/**
 * Valida que los ejes de una rejilla sean utilizables: arreglos no vacios,
 * estrictamente ascendentes, y cuyo producto de longitudes coincida con el
 * numero de valores (si se provee values).
 */
export function validateAxes(axes, valuesLength) {
  if (!axes || !Array.isArray(axes.lat_centers) || !Array.isArray(axes.lon_centers)) {
    throw new Error('Ejes de rejilla ausentes o invalidos');
  }
  const { lat_centers: lat, lon_centers: lon } = axes;
  if (lat.length === 0 || lon.length === 0) {
    throw new Error('Ejes de rejilla vacios: no es una rejilla valida');
  }
  if (!isAscending(lat)) throw new Error('lat_centers debe ser estrictamente ascendente');
  if (!isAscending(lon)) throw new Error('lon_centers debe ser estrictamente ascendente');
  if (typeof valuesLength === 'number' && valuesLength !== lat.length * lon.length) {
    throw new Error(
      `Numero de valores (${valuesLength}) no coincide con lat x lon (${lat.length}x${lon.length})`
    );
  }
  return { nLat: lat.length, nLon: lon.length };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Indice del centro de latitud mas cercano. Las latitudes se saturan a
 * [-90, 90]; en los polos se devuelve el centro extremo disponible (no hay
 * envoltura circular en latitud).
 */
export function nearestLatIndex(lat, latCenters) {
  const clamped = clamp(lat, -90, 90);
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < latCenters.length; i += 1) {
    const dist = Math.abs(latCenters[i] - clamped);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Indice del centro de longitud mas cercano, usando distancia circular
 * (modulo 360) para que el antimeridiano (+-180) se resuelva correctamente
 * en vez de comparar los valores numericos crudos.
 */
export function nearestLonIndex(lon, lonCenters) {
  const normalized = ((lon + 180) % 360 + 360) % 360 - 180; // rango [-180, 180)
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < lonCenters.length; i += 1) {
    const raw = Math.abs(lonCenters[i] - normalized);
    const circular = Math.min(raw, 360 - raw);
    if (circular < bestDist) {
      bestDist = circular;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function cellIndex(latIdx, lonIdx, nLon) {
  return latIdx * nLon + lonIdx;
}

/**
 * Devuelve la celda mas cercana a (lat, lon) dentro de un dataset con la
 * forma { axes: { lat_centers, lon_centers }, values }. El valor puede ser
 * null (sin dato original): nunca se devuelve 0 ni se extrapola.
 */
export function findNearestCell(lat, lon, dataset) {
  const { nLon } = validateAxes(dataset.axes, dataset.values.length);
  const latIdx = nearestLatIndex(lat, dataset.axes.lat_centers);
  const lonIdx = nearestLonIndex(lon, dataset.axes.lon_centers);
  const index = cellIndex(latIdx, lonIdx, nLon);
  const value = dataset.values[index];
  return {
    latIdx,
    lonIdx,
    index,
    latCenter: dataset.axes.lat_centers[latIdx],
    lonCenter: dataset.axes.lon_centers[lonIdx],
    value: value === undefined ? null : value
  };
}
