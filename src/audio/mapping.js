import {
  ANOMALY_RANGE,
  MUSIC_ANOMALY_RANGE,
  MUSIC_ASINH_SCALE,
  PENTATONIC_SCALE
} from '../config/sonification.js';

/**
 * Satura explicitamente un valor al rango dado (por defecto el rango del
 * COLOR del globo, -5..5). Nunca extrapola fuera de el.
 */
export function clampAnomaly(value, range = ANOMALY_RANGE) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error('clampAnomaly requiere un numero finito');
  }
  return Math.min(range.max, Math.max(range.min, value));
}

const ASINH_FULL = Math.asinh(MUSIC_ANOMALY_RANGE.max / MUSIC_ASINH_SCALE);

/**
 * Mapeo musical v2 (fijo, monotono, igual para todo punto/periodo, nunca
 * normalizado por ciudad): anomalia -> unidad u en [-1, 1].
 * Se satura a -12..12 y se comprime con asinh (casi lineal cerca de 0,
 * logaritmico en los extremos) para que 6 y 9 suenen distinto y -12/+12
 * sigan siendo los extremos. null/undefined/no finito => null (sin dato:
 * nunca suena como 0). `saturated` marca que el valor real excede +-12.
 */
export function anomalyToUnit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const saturated = value < MUSIC_ANOMALY_RANGE.min || value > MUSIC_ANOMALY_RANGE.max;
  const clamped = Math.min(MUSIC_ANOMALY_RANGE.max, Math.max(MUSIC_ANOMALY_RANGE.min, value));
  return { unit: Math.asinh(clamped / MUSIC_ASINH_SCALE) / ASINH_FULL, saturated };
}

/** Indice discreto 0..steps-1, monotono no decreciente con la anomalia. */
export function anomalyToStep(value, steps) {
  const mapped = anomalyToUnit(value);
  if (!mapped) return null;
  return { step: Math.round(((mapped.unit + 1) / 2) * (steps - 1)), saturated: mapped.saturated };
}

/**
 * Anomalia -> nota unica de la escala pentatonica de Do (C3..A6, 20 notas).
 * Usada por Escuchar / comparar A-B. null si no hay dato.
 */
export function anomalyToNote(value, { scale = PENTATONIC_SCALE } = {}) {
  const mapped = anomalyToStep(value, scale.length);
  return mapped ? scale[mapped.step] : null;
}

/** Valor de anomalia en el que el escalon `step` (de `steps`) empieza: frontera de cuantizacion. */
export function stepLowerBound(step, steps) {
  if (step <= 0) return -Infinity;
  const unit = ((step - 0.5) / (steps - 1)) * 2 - 1;
  return MUSIC_ASINH_SCALE * Math.sinh(unit * ASINH_FULL);
}
