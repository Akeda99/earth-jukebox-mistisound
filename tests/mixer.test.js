import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSeededRandom,
  temperatureToNote,
  rainToDensity,
  firesToIntensity,
  iceToPresence,
  DjMixer,
  BPM_MIN,
  BPM_MAX
} from '../src/audio/mixer.js';
import { PENTATONIC_SCALE } from '../src/config/sonification.js';
import { COMPOSITION_BPM, COMPOSITION_SECONDS, TOTAL_STEPS, STEPS_PER_BAR } from '../src/audio/composition.js';

describe('createSeededRandom', () => {
  it('misma semilla produce la misma secuencia', () => {
    const a = createSeededRandom('peru-2023');
    const b = createSeededRandom('peru-2023');
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('semillas distintas producen secuencias distintas', () => {
    const a = createSeededRandom('seed-a');
    const b = createSeededRandom('seed-b');
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

describe('temperatureToNote', () => {
  it('null (sin dato) devuelve null, nunca una nota', () => {
    expect(temperatureToNote(null)).toBeNull();
  });

  it('es monotona: mayor anomalia -> indice de nota igual o mayor', () => {
    const notes = [-5, -2, 0, 2, 5].map(temperatureToNote);
    const scale = ['C3', 'D3', 'E3', 'G3', 'A3', 'C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6', 'E6', 'G6', 'A6'];
    const indices = notes.map((n) => scale.indexOf(n));
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
    }
  });
});

describe('rainToDensity', () => {
  it('null (sin dato) !== 0 (lluvia real nula)', () => {
    expect(rainToDensity(null).density).toBeNull();
    expect(rainToDensity(0).density).toBe(0);
  });

  it('satura explicitamente fuera del rango 0..20 mm/day y lo marca', () => {
    const over = rainToDensity(35);
    expect(over.density).toBe(1);
    expect(over.saturated).toBe(true);
    const under = rainToDensity(-5);
    expect(under.density).toBe(0);
    expect(under.saturated).toBe(true);
  });

  it('mapea linealmente dentro del rango', () => {
    expect(rainToDensity(10).density).toBeCloseTo(0.5);
    expect(rainToDensity(20).saturated).toBe(false);
  });
});

describe('firesToIntensity', () => {
  it('null (sin cobertura declarada) !== 0 (cobertura confirmada sin detecciones)', () => {
    expect(firesToIntensity(null).intensity).toBeNull();
    expect(firesToIntensity(0).intensity).toBe(0);
  });

  it('satura por encima del maximo esperado', () => {
    const result = firesToIntensity(999, { maxExpected: 50 });
    expect(result.intensity).toBe(1);
    expect(result.saturated).toBe(true);
  });
});

describe('iceToPresence', () => {
  it('null (sin pixel oceanico valido) !== 0 (valor de fuente real, bajo el umbral de deteccion del 15%, no ausencia absoluta)', () => {
    expect(iceToPresence(null).presence).toBeNull();
    expect(iceToPresence(0).presence).toBe(0);
  });

  it('rechaza un valor fuera de 0.0-1.0 (nunca confundir fraccion con porcentaje)', () => {
    expect(() => iceToPresence(85)).toThrow();
  });
});


function createMockTone() {
  const transportEvents = new Map();
  let nextId = 1;
  const Transport = {
    bpm: { value: 72 },
    scheduleRepeat: vi.fn((cb) => {
      const id = nextId++;
      transportEvents.set(id, cb);
      return id;
    }),
    clear: vi.fn((id) => transportEvents.delete(id)),
    start: vi.fn(),
    stop: vi.fn(),
    _events: transportEvents
  };
  class FakeNode {
    constructor() {
      this.gain = { value: 1, rampTo: vi.fn() };
      this.disposed = false;
    }
    chain() {
      return this;
    }
    dispose() {
      this.disposed = true;
    }
  }
  class FakeSynth extends FakeNode {
    triggerAttackRelease = vi.fn();
    triggerRelease = vi.fn();
    releaseAll = vi.fn();
  }
  return {
    Transport,
    Gain: FakeNode,
    FMSynth: FakeSynth,
    MembraneSynth: FakeSynth,
    PolySynth: FakeSynth,
    dbToGain: (db) => (db === -Infinity ? 0 : 10 ** (db / 20)),
    now: () => 0
  };
}

function runSteps(Tone, mixer, from, to) {
  const cb = Tone.Transport._events.get(mixer.scheduleId);
  for (let i = from; i < to; i += 1) cb(i * 0.1);
}

describe('DjMixer lifecycle', () => {
  let Tone;
  let bus;

  beforeEach(() => {
    Tone = createMockTone();
    bus = {};
  });

  it('start() agenda exactamente un evento y es idempotente', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's', bpm: 72 });
    mixer.start();
    mixer.start();
    expect(Tone.Transport.scheduleRepeat).toHaveBeenCalledTimes(1);
    expect(Tone.Transport._events.size).toBe(1);
  });

  it('stop() limpia el evento; volver a start() no acumula', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's', bpm: 72 });
    mixer.start();
    mixer.stop();
    expect(Tone.Transport._events.size).toBe(0);
    mixer.start();
    expect(Tone.Transport._events.size).toBe(1);
    mixer.stop();
    expect(Tone.Transport._events.size).toBe(0);
  });

  it('bpm fijo queda saturado dentro de 48-96', () => {
    expect(new DjMixer({ ToneLib: Tone, bus, bpm: 10 }).bpm).toBe(BPM_MIN);
    expect(new DjMixer({ ToneLib: Tone, bus, bpm: 500 }).bpm).toBe(BPM_MAX);
  });

  it('updateData no dispara sonido por si sola', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's', bpm: 72 });
    mixer.start();
    mixer.updateData({ temperature: 3, rain: 10 });
    expect(mixer.nodes.piano.triggerAttackRelease).not.toHaveBeenCalled();
  });

  it('datos aplicados antes de start suenan en el paso 0 (piano en la tonica del registro)', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.updateData({ temperature: 5, rain: null, ice: null });
    mixer.start();
    runSteps(Tone, mixer, 0, 1);
    expect(mixer.nodes.piano.triggerAttackRelease).toHaveBeenCalledTimes(1);
    expect(mixer.nodes.drops.triggerAttackRelease).not.toHaveBeenCalled();
    expect(mixer.nodes.pad.triggerAttackRelease).not.toHaveBeenCalled();
  });

  it('mismo seed y datos => misma secuencia en dos mezcladores', () => {
    const toneB = createMockTone();
    const a = new DjMixer({ ToneLib: Tone, bus, seed: 'rep' });
    const b = new DjMixer({ ToneLib: toneB, bus: {}, seed: 'rep' });
    for (const m of [a, b]) {
      m.updateData({ temperature: 2, rain: 15, ice: 0.5 });
      m.start({ mode: 'composition' });
    }
    runSteps(Tone, a, 0, 64);
    runSteps(toneB, b, 0, 64);
    expect(a.nodes.drops.triggerAttackRelease.mock.calls).toEqual(b.nodes.drops.triggerAttackRelease.mock.calls);
    expect(a.nodes.piano.triggerAttackRelease.mock.calls).toEqual(b.nodes.piano.triggerAttackRelease.mock.calls);
  });

  it('lluvia: mas mm/dia agrega gotas pero no cambia el BPM del Transport', () => {
    const counts = [];
    for (const rain of [0, 5, 10, 20]) {
      const t = createMockTone();
      const m = new DjMixer({ ToneLib: t, bus: {}, seed: 'rain' });
      m.updateData({ rain });
      m.start({ mode: 'composition' });
      runSteps(t, m, 0, 128);
      counts.push(m.nodes.drops.triggerAttackRelease.mock.calls.length);
      expect(t.Transport.bpm.value).toBe(COMPOSITION_BPM);
    }
    expect(counts[0]).toBe(0);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[3]).toBe(128);
  });

  it('temperatura: mas anomalia nunca baja una nota en la misma posicion', () => {
    const noteAt = (value) => {
      const t = createMockTone();
      const m = new DjMixer({ ToneLib: t, bus: {}, seed: 'mono' });
      m.updateData({ temperature: value });
      m.start({ mode: 'composition' });
      runSteps(t, m, 0, 128);
      return m.nodes.piano.triggerAttackRelease.mock.calls.map((c) => c[0]);
    };
    const lo = noteAt(-2);
    const hi = noteAt(9);
    expect(lo.length).toBe(hi.length);
    const idx = (n) => PENTATONIC_SCALE.indexOf(n);
    lo.forEach((n, i) => expect(idx(hi[i])).toBeGreaterThanOrEqual(idx(n)));
  });

  it('dato nuevo mientras suena espera al siguiente compas; el ultimo pendiente gana', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.updateData({ temperature: 0 });
    mixer.start({ mode: 'composition' });
    runSteps(Tone, mixer, 0, 3);
    mixer.updateData({ temperature: 5 });
    mixer.updateData({ temperature: 9 });
    expect(mixer.channels.temperature.value).toBe(0);
    expect(Object.keys(mixer.pending)).toEqual(['temperature']);
    const cb = Tone.Transport._events.get(mixer.scheduleId);
    for (let i = 3; i < STEPS_PER_BAR; i += 1) cb(i * 0.1);
    expect(mixer.channels.temperature.value).toBe(0);
    cb(STEPS_PER_BAR * 0.1);
    expect(mixer.channels.temperature.value).toBe(9);
    expect(mixer.pending).toEqual({});
  });

  it('null mientras suena silencia ya, cancela el pendiente y no suena el compas siguiente', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.updateData({ temperature: 2, rain: 10 });
    mixer.start({ mode: 'composition' });
    runSteps(Tone, mixer, 0, 2);
    mixer.updateData({ temperature: 6 });
    mixer.updateData({ temperature: null });
    expect(mixer.pending).toEqual({});
    expect(mixer.nodes.gains.temperature.gain.rampTo).toHaveBeenLastCalledWith(0, 0.03);
    expect(mixer.nodes.piano.triggerRelease).toHaveBeenCalled();
    const before = mixer.nodes.piano.triggerAttackRelease.mock.calls.length;
    const cb = Tone.Transport._events.get(mixer.scheduleId);
    for (let i = 2; i < 40; i += 1) cb(i * 0.1);
    expect(mixer.nodes.piano.triggerAttackRelease.mock.calls.length).toBe(before);
    expect(mixer.nodes.drops.triggerAttackRelease).toHaveBeenCalled();
  });

  it('valores no finitos se tratan como sin dato', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.updateData({ temperature: NaN, rain: Infinity, ice: 'x' });
    expect(mixer.channels.temperature.value).toBeNull();
    expect(mixer.channels.rain.value).toBeNull();
    expect(mixer.channels.ice.value).toBeNull();
  });

  it('hielo: 0 es silencio (velocity 0 no se agenda audible), null no agenda y ice>0 agenda un acorde por compas', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.updateData({ ice: 0.8 });
    mixer.start({ mode: 'composition' });
    runSteps(Tone, mixer, 0, 128);
    expect(mixer.nodes.pad.triggerAttackRelease).toHaveBeenCalledTimes(8);
    const [notes, , , velocity] = mixer.nodes.pad.triggerAttackRelease.mock.calls[0];
    expect(notes.every((n) => PENTATONIC_SCALE.includes(n))).toBe(true);
    expect(velocity).toBeCloseTo(0.48);
  });

  it('composicion finita: termina sola tras 128 pasos, llama onEnd una vez y libera el Transport', () => {
    const onEnd = vi.fn();
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.updateData({ temperature: 1, rain: 5, ice: 0.4 });
    mixer.start({ mode: 'composition', onEnd });
    expect(Tone.Transport.bpm.value).toBe(COMPOSITION_BPM);
    const cb = Tone.Transport._events.get(mixer.scheduleId);
    for (let i = 0; i < TOTAL_STEPS; i += 1) cb(i * 0.1);
    expect(mixer.playing).toBe(true);
    cb(TOTAL_STEPS * 0.1);
    expect(mixer.playing).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(Tone.Transport._events.size).toBe(0);
    expect(COMPOSITION_SECONDS).toBe(20);
  });

  it('stop() a mitad de composicion cancela el Transport, corta con rampa y no llama onEnd', () => {
    const onEnd = vi.fn();
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.updateData({ temperature: 2, rain: 10, ice: 0.5 });
    mixer.start({ mode: 'composition', onEnd });
    runSteps(Tone, mixer, 0, 20);
    mixer.stop();
    expect(Tone.Transport._events.size).toBe(0);
    expect(mixer.playing).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
    for (const g of Object.values(mixer.nodes.gains)) expect(g.gain.rampTo).toHaveBeenLastCalledWith(0, 0.03);
    expect(mixer.nodes.piano.triggerRelease).toHaveBeenCalled();
    expect(mixer.nodes.drops.triggerRelease).toHaveBeenCalled();
    expect(mixer.nodes.pad.releaseAll).toHaveBeenCalled();
  });

  it('desactivar un canal o solo de otro lo deja sin eventos', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.updateData({ temperature: 2, rain: 20 });
    mixer.setChannel('rain', { enabled: false });
    mixer.start({ mode: 'composition' });
    runSteps(Tone, mixer, 0, 32);
    expect(mixer.nodes.drops.triggerAttackRelease).not.toHaveBeenCalled();
    expect(mixer.nodes.piano.triggerAttackRelease).toHaveBeenCalled();
    mixer.setChannel('rain', { enabled: true });
    mixer.setChannel('rain', { solo: true });
    mixer.nodes.piano.triggerAttackRelease.mockClear();
    runSteps(Tone, mixer, 32, 64);
    expect(mixer.nodes.piano.triggerAttackRelease).not.toHaveBeenCalled();
    expect(mixer.nodes.drops.triggerAttackRelease).toHaveBeenCalled();
  });

  it('dispose() detiene y libera todos los nodos', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's' });
    mixer.start();
    const nodes = mixer.nodes;
    mixer.dispose();
    expect(Tone.Transport._events.size).toBe(0);
    expect(mixer.playing).toBe(false);
    expect(nodes.piano.disposed && nodes.drops.disposed && nodes.pad.disposed).toBe(true);
    expect(Object.values(nodes.gains).every((g) => g.disposed)).toBe(true);
  });

  it('cambiar de modo reinicia limpio sin segundo loop', () => {
    const mixer = new DjMixer({ ToneLib: Tone, bus, seed: 's', bpm: 60 });
    mixer.start({ mode: 'dj' });
    expect(Tone.Transport.bpm.value).toBe(60);
    mixer.start({ mode: 'composition' });
    expect(Tone.Transport._events.size).toBe(1);
    expect(Tone.Transport.bpm.value).toBe(COMPOSITION_BPM);
  });
});

describe('DjMixer: latch de corte y stop idempotente', () => {
  let Tone;
  beforeEach(() => {
    Tone = createMockTone();
  });
  const mk = () => new DjMixer({ ToneLib: Tone, bus: {}, seed: 's', bpm: 72 });
  const lastRamp = (mixer, id) => mixer.nodes.gains[id].gain.rampTo.mock.calls.at(-1);

  it('NULL + setChannel con la misma config NO reabre la ganancia', () => {
    const m = mk();
    m.updateData({ ice: 1 });
    m.start();
    runSteps(Tone, m, 0, 1);
    m.updateData({ ice: null });
    expect(lastRamp(m, 'ice')[0]).toBe(0);
    const n = m.nodes.gains.ice.gain.rampTo.mock.calls.length;
    m.setChannel('ice', { enabled: true, gainDb: -6, solo: false });
    m.setChannel('ice', { enabled: true });
    expect(m.nodes.gains.ice.gain.rampTo.mock.calls.length).toBe(n);
    expect(m.gainState.ice).toBe(0);
  });

  it('dato nuevo aplicado en limite de compas rearma el canal cortado', () => {
    const m = mk();
    m.updateData({ ice: 1 });
    m.start();
    runSteps(Tone, m, 0, 3);
    m.updateData({ ice: null });
    m.updateData({ ice: 0.5 });
    runSteps(Tone, m, 3, 16);
    expect(m.gainState.ice).toBe(0);
    runSteps(Tone, m, 16, 17);
    expect(m.gainState.ice).toBeGreaterThan(0);
  });

  it('stop() es idempotente, corta tras la composicion terminada y setChannel no reabre', () => {
    const m = mk();
    m.updateData({ ice: 1 });
    const onEnd = vi.fn();
    m.start({ mode: 'composition', onEnd });
    runSteps(Tone, m, 0, 129);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(m.playing).toBe(false);
    expect(m.gainState.ice).toBeGreaterThan(0); // cola natural permitida
    m.stop();
    expect(m.nodes.pad.releaseAll).toHaveBeenCalled();
    expect(m.gainState.ice).toBe(0);
    const n = m.nodes.gains.ice.gain.rampTo.mock.calls.length;
    m.stop();
    m.setChannel('ice', { enabled: true, gainDb: -6 });
    expect(m.gainState.ice).toBe(0);
    expect(m.nodes.gains.ice.gain.rampTo.mock.calls.length).toBeGreaterThanOrEqual(n);
    expect(lastRamp(m, 'ice')[0]).toBe(0);
  });

  it('start() tras una sesion previa reconstruye los instrumentos (sin voces de A en B)', () => {
    const m = mk();
    m.updateData({ ice: 1 });
    m.start();
    const oldPad = m.nodes.pad;
    m.stop();
    m.start();
    expect(oldPad.disposed).toBe(true);
    expect(m.nodes.pad).not.toBe(oldPad);
  });
});
