import { validateAxes } from './grid.js';

const REQUIRED_STRING_FIELDS = ['period', 'units', 'baseline_period'];

/**
 * Valida la forma de un JSON de rejilla mensual exportado por
 * scripts/prepare_gistemp.py. Lanza si el dataset esta vacio, mal formado,
 * o si le faltan metadatos necesarios para mostrarlo/sonificarlo
 * correctamente (nunca se acepta un resultado vacio como dataset valido).
 */
export function validateGistempDataset(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('Dataset invalido: no es un objeto JSON');
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof json[field] !== 'string' || json[field].length === 0) {
      throw new Error(`Dataset invalido: falta el campo '${field}'`);
    }
  }
  if (!Array.isArray(json.values) || json.values.length === 0) {
    throw new Error('Dataset invalido: "values" vacio o ausente');
  }
  validateAxes(json.axes, json.values.length);
  if (typeof json.smoothing_radius_km !== 'number') {
    throw new Error('Dataset invalido: falta smoothing_radius_km');
  }
  if (typeof json.grid_resolution_deg !== 'number') {
    throw new Error('Dataset invalido: falta grid_resolution_deg');
  }
  const allNull = json.values.every((v) => v === null);
  if (allNull) {
    throw new Error('Dataset invalido: todas las celdas estan sin dato');
  }
  return json;
}

const SEA_ICE_REQUIRED_STRING_FIELDS = ['period', 'units', 'dataset'];

/**
 * Valida la forma de un JSON mensual exportado por
 * scripts/prepare_sea_ice_g02135.py (NOAA/NSIDC G02135). A diferencia de
 * GISTEMP, aqui una mayoria de celdas null (tierra/pole-hole/costa/sin
 * cobertura oceanica) es normal y esperado (ver
 * aggregation_approximation_note en el propio dataset): no se rechaza un
 * dataset solo por tener muchas celdas sin dato, solo por tener la forma
 * incorrecta o CERO celdas con dato real.
 */
export function validateSeaIceDataset(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('Dataset de hielo invalido: no es un objeto JSON');
  }
  for (const field of SEA_ICE_REQUIRED_STRING_FIELDS) {
    if (typeof json[field] !== 'string' || json[field].length === 0) {
      throw new Error(`Dataset de hielo invalido: falta el campo '${field}'`);
    }
  }
  if (!Array.isArray(json.values) || json.values.length === 0) {
    throw new Error('Dataset de hielo invalido: "values" vacio o ausente');
  }
  validateAxes(json.axes, json.values.length);
  if (typeof json.grid_resolution_deg !== 'number') {
    throw new Error('Dataset de hielo invalido: falta grid_resolution_deg');
  }
  if (!Array.isArray(json.coverage) || json.coverage.length !== json.values.length) {
    throw new Error('Dataset de hielo invalido: "coverage" ausente o de tamano distinto a "values"');
  }
  for (const v of json.values) {
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
      throw new Error('Dataset de hielo invalido: cada valor debe ser null o una fraccion 0.0-1.0');
    }
  }
  const allNull = json.values.every((v) => v === null);
  if (allNull) {
    throw new Error('Dataset de hielo invalido: todas las celdas estan sin dato');
  }
  return json;
}
