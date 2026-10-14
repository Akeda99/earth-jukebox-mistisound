import { describe, it, expect, vi } from 'vitest';
import { AudioEngine } from '../src/audio/engine.js';

// Mock minimo de Tone.js: suficiente para verificar las invariantes del
// motor (idempotencia de start, mute antes de start, no solapar notas, etc.)
// sin un AudioContext real.
function createFakeTone() {
  const gainNodes = [];
  const synths = [];

  class FakeParam {
    constructor(value) {
      this.value = value;
    }
    rampTo(value) {
      this.value = value;
    }
  }

  class FakeGain {
    constructor(value) {
      this.gain = new FakeParam(value);
    }
    dispose() {}
  }

  class FakeLimiter {
    dispose() {}
  }

  class FakeSynth {
    constructor() {
      this.triggered = [];
      this.released = [];
      gainNodes.push(this);
    }
    chain() {}
    triggerAttackRelease(note, duration, time) {
      if (this.triggered.length > 0) {
        const last = this.triggered[this.triggered.length - 1].time;
        if (time <= last) {
          throw new Error('Start time must be strictly greater than previous start time');
        }
      }
      this.triggered.push({ note, duration, time });
    }
    triggerRelease(time) {
      this.released.push(time);
    }
    dispose() {}
  }

  let now = 0;
  let startCalls = 0;

  return {
    async start() {
      startCalls += 1;
      await Promise.resolve();
    },
    get startCallCount() {
      return startCalls;
    },
    dbToGain(db) {
      return db === -Infinity ? 0 : Math.pow(10, db / 20);
    },
    now() {
      return now;
    },
    advanceTime(delta) {
      now += delta;
    },
    Gain: FakeGain,
    Limiter: FakeLimiter,
    Synth: FakeSynth,
    Destination: {}
  };
}

describe('AudioEngine', () => {
  it('start() es idempotente ante llamadas concurrentes: solo crea un synth/gain', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });

    await Promise.all([engine.start(), engine.start(), engine.start()]);

    expect(ToneLib.startCallCount).toBe(1);
    expect(engine.isStarted()).toBe(true);
  });

  it('aplica el mute preseleccionado ANTES de construir/conectar el gain (sin ventana audible)', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });

    engine.setMuted(true); // mute pedido antes de start()
    await engine.start();

    expect(engine.gain.gain.value).toBe(0); // dbToGain(-Infinity) = 0, ya aplicado al crear
  });

  it('aplica el volumen preseleccionado antes de start()', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });

    engine.setVolumeDb(-20);
    await engine.start();

    expect(engine.gain.gain.value).toBeCloseTo(ToneLib.dbToGain(-20), 6);
  });

  it('bloquea playAnomaly mientras esta muteado (no solo atenua)', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });
    await engine.start();
    engine.setMuted(true);

    const note = engine.playAnomaly(2);
    expect(note).toBeNull();
    expect(engine.synth.triggered.length).toBe(0);
  });

  it('mutear corta cualquier nota sostenida (triggerRelease) para que un unmute no la revele', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });
    await engine.start();
    engine.playAnomaly(2);

    engine.setMuted(true);

    expect(engine.synth.released.length).toBe(1);
  });

  it('no lanza con disparos repetidos en el mismo timestamp (sintetizador monofonico)', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });
    await engine.start();

    expect(() => {
      engine.playAnomaly(1);
      engine.playAnomaly(2); // mismo `now()` que la anterior: no debe lanzar
      engine.playAnomaly(-1);
    }).not.toThrow();

    const times = engine.synth.triggered.map((t) => t.time);
    // Los tiempos deben ser estrictamente crecientes.
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  it('playAnomaly no hace nada si el motor no arranco', () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });
    expect(engine.playAnomaly(2)).toBeNull();
  });

  it('setVolumeDb ignora valores no finitos y satura al rango documentado', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });
    await engine.start();

    engine.setVolumeDb(NaN);
    expect(engine.volumeDb).not.toBeNaN();

    engine.setVolumeDb(100); // por encima del maximo documentado (0 dB)
    expect(engine.volumeDb).toBe(0);

    engine.setVolumeDb(-1000); // por debajo del minimo documentado (-40 dB)
    expect(engine.volumeDb).toBe(-40);
  });

  it('setDucked reduce temporalmente el volumen sin tocar el mute del usuario', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });
    engine.setVolumeDb(-10);
    await engine.start();

    const normalGain = engine.gain.gain.value;
    engine.setDucked(true);
    const duckedGain = engine.gain.gain.value;
    expect(duckedGain).toBeLessThan(normalGain);
    expect(engine.isMuted()).toBe(false);

    engine.setDucked(false);
    expect(engine.gain.gain.value).toBeCloseTo(normalGain, 6);
  });

  it('dispose() limpia los nodos y permite volver a start() despues', async () => {
    const ToneLib = createFakeTone();
    const engine = new AudioEngine({ ToneLib });
    await engine.start();
    engine.dispose();
    expect(engine.isStarted()).toBe(false);

    await engine.start();
    expect(engine.isStarted()).toBe(true);
  });
});
