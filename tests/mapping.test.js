import { describe, it, expect } from 'vitest';
import { clampAnomaly, anomalyToNote, anomalyToUnit, anomalyToStep, stepLowerBound } from '../src/audio/mapping.js';
import { PENTATONIC_SCALE, ANOMALY_RANGE, MUSIC_ANOMALY_RANGE } from '../src/config/sonification.js';

describe('clampAnomaly', () => {
  it('deja pasar valores dentro del rango', () => {
    expect(clampAnomaly(2.5)).toBe(2.5);
  });

  it('satura explicitamente por encima del maximo', () => {
    expect(clampAnomaly(50)).toBe(ANOMALY_RANGE.max);
  });

  it('satura explicitamente por debajo del minimo', () => {
    expect(clampAnomaly(-50)).toBe(ANOMALY_RANGE.min);
  });

  it('rechaza valores no numericos', () => {
    expect(() => clampAnomaly(NaN)).toThrow();
    expect(() => clampAnomaly('x')).toThrow();
  });
});

describe('anomalyToNote (mapeo musical v2: -12..12, asinh)', () => {
  it('null/undefined/no finito => null, nunca una nota', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, 'x']) {
      expect(anomalyToNote(v)).toBeNull();
      expect(anomalyToUnit(v)).toBeNull();
    }
  });

  it('null no es 0: 0 produce una nota, null no', () => {
    expect(anomalyToNote(0)).not.toBeNull();
    expect(anomalyToNote(null)).toBeNull();
  });

  it('los extremos del rango musical son la primera y la ultima nota', () => {
    expect(anomalyToNote(MUSIC_ANOMALY_RANGE.min)).toBe(PENTATONIC_SCALE[0]);
    expect(anomalyToNote(MUSIC_ANOMALY_RANGE.max)).toBe(PENTATONIC_SCALE[PENTATONIC_SCALE.length - 1]);
  });

  it('ya no satura en +-5: 5, 7.82 y 9 siguen siendo distinguibles de los extremos', () => {
    expect(anomalyToUnit(5).saturated).toBe(false);
    expect(anomalyToUnit(7.82).saturated).toBe(false);
    expect(anomalyToNote(7.82)).not.toBe(anomalyToNote(MUSIC_ANOMALY_RANGE.max));
  });

  it('6 y 9 suenan distinto', () => {
    expect(anomalyToNote(6)).not.toBe(anomalyToNote(9));
    expect(PENTATONIC_SCALE.indexOf(anomalyToNote(9))).toBeGreaterThan(PENTATONIC_SCALE.indexOf(anomalyToNote(6)));
  });

  it('-2 < 0 < 2 en altura', () => {
    const idx = (v) => PENTATONIC_SCALE.indexOf(anomalyToNote(v));
    expect(idx(-2)).toBeLessThan(idx(0));
    expect(idx(0)).toBeLessThan(idx(2));
  });

  it('fuera de +-12 satura y lo marca; dentro no', () => {
    expect(anomalyToUnit(100).saturated).toBe(true);
    expect(anomalyToUnit(-100).saturated).toBe(true);
    expect(anomalyToUnit(100).unit).toBe(1);
    expect(anomalyToUnit(12).saturated).toBe(false);
    expect(anomalyToNote(100)).toBe(anomalyToNote(12));
  });

  it('es monotona no decreciente en todo el rango y solo usa notas de la escala', () => {
    let last = -1;
    for (let v = -15; v <= 15; v += 0.1) {
      const note = anomalyToNote(v);
      expect(PENTATONIC_SCALE).toContain(note);
      const i = PENTATONIC_SCALE.indexOf(note);
      expect(i).toBeGreaterThanOrEqual(last);
      last = i;
    }
  });

  it('no depende de la ciudad ni del periodo: es una funcion pura del valor', () => {
    expect(anomalyToNote(3.3)).toBe(anomalyToNote(3.3));
  });

  it('stepLowerBound es creciente y coherente con anomalyToStep', () => {
    const steps = PENTATONIC_SCALE.length;
    let prev = -Infinity;
    for (let s = 1; s < steps; s += 1) {
      const b = stepLowerBound(s, steps);
      expect(b).toBeGreaterThan(prev);
      prev = b;
      expect(anomalyToStep(b + 1e-6, steps).step).toBeGreaterThanOrEqual(s);
      expect(anomalyToStep(b - 1e-6, steps).step).toBeLessThan(s);
    }
  });
});
