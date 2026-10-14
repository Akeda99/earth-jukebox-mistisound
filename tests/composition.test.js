import { describe, it, expect } from 'vitest';
import {
  BAR_SEQUENCE,
  TOTAL_STEPS,
  COMPOSITION_SECONDS,
  COMPOSITION_BPM,
  planStep,
  hash01,
  anomalyToRegister,
  rainDensity,
  describeSounding,
  chordForBar
} from '../src/audio/composition.js';
import { PENTATONIC_SCALE } from '../src/config/sonification.js';

const PENTA_NAMES = new Set(['C', 'D', 'E', 'G', 'A']);
const pitchClass = (n) => n.replace(/\d+$/, '');

function plan(all) {
  return Array.from({ length: TOTAL_STEPS }, (_, step) => planStep({ step, ...all }));
}

describe('composicion: estructura', () => {
  it('dura 20 s: 8 compases 4/4 a 96 BPM', () => {
    expect(COMPOSITION_BPM).toBe(96);
    expect(TOTAL_STEPS).toBe(128);
    expect(COMPOSITION_SECONDS).toBe(20);
    expect(BAR_SEQUENCE).toHaveLength(8);
  });

  it('motivo, gotas y acordes pertenecen a la pentatonica C D E G A', () => {
    const p = plan({ temperature: 3, rain: 20, ice: 1, seed: 'x' });
    for (const s of p) {
      if (s.melody) expect(PENTA_NAMES.has(pitchClass(s.melody.note))).toBe(true);
      if (s.drop) expect(PENTA_NAMES.has(pitchClass(s.drop.note))).toBe(true);
      if (s.pad) s.pad.notes.forEach((n) => expect(PENTA_NAMES.has(pitchClass(n))).toBe(true));
    }
    for (let b = 0; b < 8; b += 1) chordForBar(b).forEach((n) => expect(PENTATONIC_SCALE).toContain(n));
  });

  it('mismo seed y datos => plan identico; seed solo cambia variantes, no el ritmo', () => {
    const a = plan({ temperature: 2, rain: 8, ice: 0.5, seed: 'a' });
    expect(plan({ temperature: 2, rain: 8, ice: 0.5, seed: 'a' })).toEqual(a);
    const b = plan({ temperature: 2, rain: 8, ice: 0.5, seed: 'b' });
    expect(b.map((s) => Boolean(s.melody))).toEqual(a.map((s) => Boolean(s.melody)));
  });
});

describe('composicion: comparabilidad', () => {
  it('mas anomalia nunca baja una nota en la misma posicion (misma semilla)', () => {
    const values = [-12, -6, -2, 0, 2, 6, 7.82, 9, 12];
    let prev = null;
    for (const v of values) {
      const cur = plan({ temperature: v, seed: 's' }).map((s) => (s.melody ? PENTATONIC_SCALE.indexOf(s.melody.note) : -1));
      if (prev) cur.forEach((n, i) => expect(n).toBeGreaterThanOrEqual(prev[i]));
      prev = cur;
    }
  });

  it('6 y 9 usan registros distintos; -2 < 0 < 2', () => {
    expect(anomalyToRegister(9).register).toBeGreaterThan(anomalyToRegister(6).register);
    expect(anomalyToRegister(-2).register).toBeLessThan(anomalyToRegister(0).register);
    expect(anomalyToRegister(0).register).toBeLessThan(anomalyToRegister(2).register);
  });

  it('lluvia: subir mm/dia solo agrega gotas (conjunto anidado)', () => {
    let prev = new Set();
    for (const r of [0, 2, 5, 10, 20]) {
      const hits = new Set(plan({ rain: r, seed: 's' }).filter((s) => s.drop).map((s) => s.step));
      prev.forEach((st) => expect(hits.has(st)).toBe(true));
      prev = hits;
    }
    expect(prev.size).toBe(TOTAL_STEPS);
  });

  it('hielo: 0 no es null; null sin pad; velocity proporcional a la fraccion', () => {
    expect(plan({ ice: null }).some((s) => s.pad)).toBe(false);
    const zero = plan({ ice: 0 }).filter((s) => s.pad);
    expect(zero.every((s) => s.pad.velocity === 0)).toBe(true);
    const full = plan({ ice: 1 }).filter((s) => s.pad);
    expect(full).toHaveLength(8);
    expect(full[0].pad.velocity).toBeGreaterThan(plan({ ice: 0.5 }).find((s) => s.pad).pad.velocity);
  });

  it('null en cada canal => ese instrumento no suena; 0 de lluvia suena como cero gotas', () => {
    const p = plan({ temperature: null, rain: null, ice: null });
    expect(p.every((s) => !s.melody && !s.drop && !s.pad)).toBe(true);
    expect(rainDensity(null).density).toBeNull();
    expect(rainDensity(0).density).toBe(0);
  });

  it('valores no finitos o fuera de rango de hielo no suenan', () => {
    expect(anomalyToRegister(NaN)).toBeNull();
    expect(plan({ ice: 1.5 }).some((s) => s.pad)).toBe(false);
    expect(plan({ ice: -0.1 }).some((s) => s.pad)).toBe(false);
    expect(plan({ rain: NaN }).some((s) => s.drop)).toBe(false);
  });

  it('describeSounding resume lo que realmente suena', () => {
    const d = describeSounding({ temperature: 7.82, rain: null, ice: 0 });
    expect(d.piano).not.toBeNull();
    expect(d.drops).toBeNull();
    expect(d.ice.silent).toBe(true);
    expect(describeSounding({ temperature: 50 }).piano.saturated).toBe(true);
  });

  it('hash01 es determinista y esta en [0,1)', () => {
    expect(hash01('a', 1, 2)).toBe(hash01('a', 1, 2));
    expect(hash01('a', 1, 2)).not.toBe(hash01('b', 1, 2));
    for (let i = 0; i < 100; i += 1) {
      const h = hash01('s', i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});
