// Composicion determinista de Earth Jukebox (version musical 2). Modulo PURO:
// sin Tone ni estado. Dado un paso de semicorchea + los tres valores de
// datos + la semilla, devuelve QUE debe sonar; audio/mixer.js solo lo
// reproduce. Reglas (detalle y tabla en docs/sonification-rules.md):
//  - 8 compases 4/4 a 96 BPM = 20 s (128 semicorcheas).
//  - Piano (temperatura): motivo pentatonico CDEGA de rejilla rítmica fija.
//    La anomalia solo elige el REGISTRO (0..15 pasos pentatonicos): el mismo
//    motivo mas arriba; a mas anomalia nunca baja una nota en la misma
//    posicion. La semilla solo elige variantes de 3 compases, igual para
//    cualquier dato.
//  - Gotas (lluvia): mas mm/dia = mas semicorcheas con gota. Cada paso tiene
//    un umbral fijo por semilla; golpea si umbral < densidad, asi que subir
//    la lluvia solo AGREGA gotas. El tempo nunca depende del dato.
//  - Hielo: acorde pentatonico suave una vez por compas, volumen = fraccion.
//    0 = silencio real; null = no hay instrumento.
import { PENTATONIC_SCALE } from '../config/sonification.js';
import { anomalyToStep } from './mapping.js';

export const BARS = 8;
export const STEPS_PER_BAR = 16;
export const TOTAL_STEPS = BARS * STEPS_PER_BAR;
export const COMPOSITION_BPM = 96;
export const COMPOSITION_SECONDS = (TOTAL_STEPS * 60) / COMPOSITION_BPM / 4;
export const REGISTER_STEPS = 16; // base 0..15 + grado 0..4 => nunca pasa de A6
export const RAIN_RANGE = { min: 0, max: 20 }; // mm/day, decision musical

const DROP_DEGREE_OFFSET = 15; // gotas en la octava 6 (C6..A6)

// [paso dentro del compas, grado 0..4 de C D E G A, duracion en pasos]
const BAR_A = [[0, 0, 4], [4, 1, 2], [6, 2, 2], [8, 3, 4], [12, 4, 2], [14, 3, 2]]; // C D E G A G
const BAR_B = [[0, 2, 4], [4, 3, 2], [6, 4, 2], [8, 3, 2], [10, 2, 2], [12, 1, 4]]; // E G A G E D
const BAR_C = [[0, 4, 4], [4, 3, 2], [6, 2, 2], [8, 1, 4], [12, 2, 2], [14, 1, 2]]; // A G E D E D
const BAR_END = [[0, 2, 4], [4, 1, 4], [8, 0, 8]]; // E D C (reposo en la tonica)
export const BAR_SEQUENCE = [BAR_A, BAR_A, BAR_B, BAR_C, BAR_A, BAR_A, BAR_B, BAR_END];
const VARIANT_BARS = new Set([1, 3, 5]);

// Un acorde por compas, cambia cada 2: C-E-G, A-C-E, D-G-A, C-E-G.
const CHORDS = [
  ['C5', 'E5', 'G5'],
  ['A4', 'C5', 'E5'],
  ['D5', 'G5', 'A5'],
  ['C5', 'E5', 'G5']
];

export function chordForBar(bar) {
  return CHORDS[Math.floor((((bar % BARS) + BARS) % BARS) / 2)];
}

/** Hash determinista (semilla, a, b) -> [0, 1). Sin estado: no hay PRNG que reiniciar. */
export function hash01(seed, a, b = 0) {
  const text = `${seed}|${a}|${b}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Anomalia -> registro 0..15 del motivo (null = sin dato). */
export function anomalyToRegister(value) {
  const mapped = anomalyToStep(value, REGISTER_STEPS);
  return mapped ? { register: mapped.step, saturated: mapped.saturated } : null;
}

/** Lluvia mm/dia -> densidad 0..1 (null = sin dato, distinto de 0). */
export function rainDensity(value) {
  if (!isNumber(value)) return { density: null, saturated: false };
  const saturated = value < RAIN_RANGE.min || value > RAIN_RANGE.max;
  const clamped = Math.min(RAIN_RANGE.max, Math.max(RAIN_RANGE.min, value));
  return { density: (clamped - RAIN_RANGE.min) / (RAIN_RANGE.max - RAIN_RANGE.min), saturated };
}

function motifEvent(bar, slot, seed) {
  const pattern = BAR_SEQUENCE[bar];
  let events = pattern.map((e) => [...e]);
  if (VARIANT_BARS.has(bar)) {
    const variant = Math.floor(hash01(seed, 'variant', bar) * 3);
    // Variante 0 = patron base. 1: la ultima nota baja un grado. 2: se
    // intercambian los grados de las dos ultimas notas. Posiciones fijas.
    if (variant === 1) events[events.length - 1][1] = Math.max(0, events[events.length - 1][1] - 1);
    if (variant === 2 && events.length >= 2) {
      const a = events[events.length - 2];
      const b = events[events.length - 1];
      [a[1], b[1]] = [b[1], a[1]];
    }
  }
  return events.find((e) => e[0] === slot) ?? null;
}

/**
 * Plan de un paso (0..127 dentro de la cancion). Devuelve eventos para los
 * tres instrumentos; un instrumento cuyo dato sea null/invalido no produce
 * evento. `step` fuera de rango da vuelta (el DJ continuo repite la pieza).
 */
export function planStep({ step, temperature = null, rain = null, ice = null, seed = 'earth-jukebox' }) {
  const s = ((step % TOTAL_STEPS) + TOTAL_STEPS) % TOTAL_STEPS;
  const bar = Math.floor(s / STEPS_PER_BAR);
  const slot = s % STEPS_PER_BAR;
  const plan = { step: s, bar, slot, melody: null, drop: null, pad: null };

  const reg = anomalyToRegister(temperature);
  if (reg) {
    const event = motifEvent(bar, slot, seed);
    if (event) {
      const [, degree, lengthSteps] = event;
      plan.melody = {
        note: PENTATONIC_SCALE[reg.register + degree],
        degree,
        register: reg.register,
        lengthSteps,
        velocity: slot === 0 ? 0.85 : 0.6
      };
    }
  }

  const { density } = rainDensity(rain);
  if (density !== null && hash01(seed, 'rain', s) < density) {
    const degree = Math.floor(hash01(seed, 'drop-pitch', s) * 5);
    plan.drop = {
      note: PENTATONIC_SCALE[DROP_DEGREE_OFFSET + degree],
      velocity: 0.45 + 0.3 * hash01(seed, 'drop-vel', s)
    };
  }

  if (isNumber(ice) && ice >= 0 && ice <= 1 && slot === 0) {
    plan.pad = { notes: chordForBar(bar), level: ice, velocity: 0.6 * ice };
  }
  return plan;
}

/** Resumen de lo que suena para un conjunto de datos (UI y pruebas). */
export function describeSounding({ temperature = null, rain = null, ice = null }) {
  const reg = anomalyToRegister(temperature);
  const { density, saturated: rainSaturated } = rainDensity(rain);
  const iceValid = isNumber(ice) && ice >= 0 && ice <= 1;
  return {
    piano: reg ? { register: reg.register, saturated: reg.saturated } : null,
    drops: density === null ? null : { density, saturated: rainSaturated },
    ice: iceValid ? { level: ice, silent: ice === 0 } : null
  };
}
