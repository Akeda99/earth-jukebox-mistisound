// Mezclador del DJ y de la composicion finita (version musical 2). Tres
// instrumentos sintetizados con Tone (sin muestras externas), uno por canal
// real: piano suave FM (temperatura GISTEMP), gotas (lluvia NASA POWER) y
// pad cristalino (hielo NOAA/NSIDC G02135). Incendios sigue SIN datos reales
// (FIRMS bloqueado por autenticacion, ver docs/dj-data-sources.md): mapeo
// puro probado, nunca se instancia un instrumento con datos inventados.
// Que suena en cada paso lo decide audio/composition.js (puro, determinista);
// aqui solo se agenda en Tone.Transport (un unico pulso de semicorcheas) y
// todo sale por el bus global del AudioEngine (ganancia + limiter + mute).
//
// Datos en vivo:
//  - Sin reproducir, updateData aplica al instante.
//  - Reproduciendo, un valor nuevo espera al siguiente compas (un solo
//    pendiente por canal: el ultimo gana, nunca se acumulan).
//  - null/dato invalido NO espera: silencia ese canal ya (rampa de 30 ms) y
//    cancela su pendiente.
//  - stop() corta todo con la misma rampa y cancela el Transport.
//  - mode 'composition' toca 128 pasos (20 s) a 96 BPM y termina solo,
//    dejando decaer la cola de release (acotada, < 3 s). mode 'dj' repite.

import { anomalyToNote } from './mapping.js';
import { TOTAL_STEPS, STEPS_PER_BAR, COMPOSITION_BPM, planStep, rainDensity } from './composition.js';

export const BPM_MIN = 48;
export const BPM_MAX = 96;
export { RAIN_RANGE } from './composition.js';
const CUT_SECONDS = 0.03;
const GAIN_RAMP_SECONDS = 0.02;
const DATA_CHANNELS = ['temperature', 'rain', 'ice'];

/** mulberry32: PRNG determinista y rapido, suficiente para decidir patrones. */
export function createSeededRandom(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (let i = 0; i < String(seed).length; i += 1) {
    h = Math.imul(h ^ String(seed).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Temperatura -> nota unica (mapeo v2). null = sin dato, nunca una nota. */
export function temperatureToNote(value) {
  return anomalyToNote(value);
}

/**
 * Lluvia (mm/day) -> densidad 0..1 sobre RAIN_RANGE. null (sin dato) da
 * density: null, distinto de density: 0 (cero lluvia real).
 */
export function rainToDensity(value) {
  return rainDensity(value);
}

/** Incendios: mapeo PURO sin datos reales (ver cabecera). null !== 0. */
export function firesToIntensity(count, { maxExpected = 50 } = {}) {
  if (count === null || count === undefined) return { intensity: null, saturated: false };
  const saturated = count > maxExpected;
  return { intensity: clamp(count, 0, maxExpected) / maxExpected, saturated };
}

/** Hielo: fraccion 0..1 -> presencia (volumen). null !== 0 (0 = bajo umbral de G02135). */
export function iceToPresence(fraction) {
  if (fraction === null || fraction === undefined) return { presence: null };
  if (fraction < 0 || fraction > 1) {
    throw new Error('iceToPresence espera una fraccion 0.0-1.0, no un porcentaje');
  }
  return { presence: fraction };
}

function normalizeValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class DjMixer {
  constructor({ ToneLib, bus, seed = 'earth-jukebox', bpm = 72 } = {}) {
    this.Tone = ToneLib;
    this.bus = bus;
    this.seed = seed;
    this.bpm = clamp(bpm, BPM_MIN, BPM_MAX);
    this.playing = false;
    this.mode = 'dj';
    this.onEnd = null;
    this.scheduleId = null;
    this.stepIndex = 0;
    this.pending = {};
    this.channels = {
      temperature: { enabled: true, gainDb: -6, value: null },
      rain: { enabled: true, gainDb: -6, value: null },
      ice: { enabled: true, gainDb: -6, value: null }
    };
    this.nodes = null;
    this.gainState = {};
    // Latch por canal: un corte (NULL o stop) mantiene la ganancia en 0 aunque
    // setChannel/render vuelvan a aplicar la misma config; solo un dato nuevo
    // aplicado en limite de compas o un start() lo rearman.
    this.latched = {};
    this.used = false;
  }

  setSeed(seed) {
    this.seed = seed;
  }

  setBpm(bpm) {
    this.bpm = clamp(bpm, BPM_MIN, BPM_MAX);
    if (this.Tone?.Transport && this.mode !== 'composition') this.Tone.Transport.bpm.value = this.bpm;
  }

  setChannel(id, patch) {
    if (!this.channels[id]) return;
    Object.assign(this.channels[id], patch);
    if (this.nodes) this._applyChannelGain(id);
  }

  /**
   * Datos confirmados del punto. Parado: aplica ya. Sonando: valor nuevo al
   * siguiente compas (un pendiente por canal, el ultimo gana); null/invalido
   * silencia ese canal ya y cancela su pendiente.
   */
  updateData(data = {}) {
    for (const id of DATA_CHANNELS) {
      if (data[id] === undefined) continue;
      const value = normalizeValue(data[id]);
      const ch = this.channels[id];
      if (value === null) {
        delete this.pending[id];
        ch.value = null;
        if (this.nodes && !this.latched[id]) this._cutChannel(id);
      } else if (!this.playing) {
        ch.value = value;
        delete this.pending[id];
      } else if (Object.is(value, ch.value)) {
        delete this.pending[id];
      } else {
        this.pending[id] = value;
      }
    }
  }

  _applyPending() {
    for (const [id, value] of Object.entries(this.pending)) {
      this.channels[id].value = value;
      delete this.latched[id];
    }
    this.pending = {};
  }

  _hasSolo() {
    return Object.values(this.channels).some((c) => c.solo);
  }

  _audible(id) {
    const ch = this.channels[id];
    return ch.enabled && (!this._hasSolo() || Boolean(ch.solo));
  }

  _applyChannelGain(id, rampSeconds = GAIN_RAMP_SECONDS) {
    const node = this.nodes?.gains[id];
    if (!node) return;
    const target = !this.latched[id] && this._audible(id) ? this.Tone.dbToGain(this.channels[id].gainDb) : 0;
    if (this.gainState[id] === target) return;
    this.gainState[id] = target;
    node.gain.rampTo(target, rampSeconds);
  }

  _cutChannel(id) {
    const node = this.nodes?.gains[id];
    if (!node) return;
    this.latched[id] = true;
    this.gainState[id] = 0;
    node.gain.rampTo(0, CUT_SECONDS);
    const now = this.Tone.now();
    if (id === 'ice') this.nodes.pad.releaseAll(now);
    else if (id === 'rain') this.nodes.drops.triggerRelease(now);
    else this.nodes.piano.triggerRelease(now);
  }

  _ensureNodes() {
    if (this.nodes) return;
    const T = this.Tone;
    const gains = {
      temperature: new T.Gain(0),
      rain: new T.Gain(0),
      ice: new T.Gain(0)
    };
    // Piano suave: FM con ataque percusivo y decaimiento sin sostenido.
    const piano = new T.FMSynth({
      harmonicity: 1,
      modulationIndex: 1.6,
      envelope: { attack: 0.004, decay: 0.9, sustain: 0, release: 0.5 },
      modulationEnvelope: { attack: 0.002, decay: 0.3, sustain: 0, release: 0.3 },
      volume: -4
    });
    // Gotas: tono corto con caida de altura, sin sostenido.
    const drops = new T.MembraneSynth({
      pitchDecay: 0.015,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.03 },
      volume: -4
    });
    // Pad cristalino: FM suave, ataque y release largos.
    const pad = new T.PolySynth(T.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 0.8,
      envelope: { attack: 0.35, decay: 0.3, sustain: 0.7, release: 2.0 },
      modulationEnvelope: { attack: 0.5, decay: 0.2, sustain: 0.5, release: 1.5 },
      volume: -8
    });
    piano.chain(gains.temperature, this.bus);
    drops.chain(gains.rain, this.bus);
    pad.chain(gains.ice, this.bus);
    this.nodes = { gains, piano, drops, pad };
  }

  /**
   * Arranca el pulso de semicorcheas en Tone.Transport. mode 'dj' repite la
   * pieza sin fin; 'composition' toca 8 compases a 96 BPM y llama onEnd.
   * Idempotente en el mismo modo; cambiar de modo reinicia limpio.
   */
  start({ mode = 'dj', onEnd = null } = {}) {
    if (this.playing) {
      if (mode === this.mode) return;
      this.stop();
    }
    // Voces de una sesion anterior (p.ej. cola de 2 s del pad) nunca se mezclan
    // con la nueva: se reconstruyen los instrumentos.
    if (this.used) this._disposeNodes();
    this._ensureNodes();
    this.used = true;
    this.latched = {};
    this._applyPending();
    this.mode = mode;
    this.onEnd = onEnd;
    this.stepIndex = 0;
    this.Tone.Transport.bpm.value = mode === 'composition' ? COMPOSITION_BPM : this.bpm;
    for (const id of DATA_CHANNELS) this._applyChannelGain(id, 0.005);
    this.scheduleId = this.Tone.Transport.scheduleRepeat((time) => this._onStep(time), '16n');
    this.Tone.Transport.start();
    this.playing = true;
  }

  _clearTransport() {
    if (this.scheduleId !== null) {
      this.Tone.Transport.clear(this.scheduleId);
      this.scheduleId = null;
    }
    this.Tone.Transport.stop();
  }

  /** Corte inmediato (rampa de 30 ms + release forzado) y cancela el Transport. */
  stop() {
    if (this.playing || this.scheduleId !== null) this._clearTransport();
    this.playing = false;
    this._applyPending();
    this.onEnd = null;
    if (this.nodes) for (const id of DATA_CHANNELS) this._cutChannel(id);
  }

  _finishComposition() {
    this._clearTransport();
    this.playing = false;
    this._applyPending();
    const cb = this.onEnd;
    this.onEnd = null;
    cb?.({ reason: 'ended' });
  }

  _onStep(time) {
    if (this.mode === 'composition' && this.stepIndex >= TOTAL_STEPS) {
      this._finishComposition();
      return;
    }
    if (this.stepIndex % STEPS_PER_BAR === 0) this._applyPending();
    const v = (id) => this.channels[id].value;
    const plan = planStep({
      step: this.stepIndex,
      temperature: this._audible('temperature') ? v('temperature') : null,
      rain: this._audible('rain') ? v('rain') : null,
      ice: this._audible('ice') ? v('ice') : null,
      seed: this.seed
    });
    const stepSeconds = 60 / this.Tone.Transport.bpm.value / 4;
    if (plan.melody) {
      this._applyChannelGain('temperature');
      const dur = Math.max(plan.melody.lengthSteps * stepSeconds * 0.95, 0.05);
      this.nodes.piano.triggerAttackRelease(plan.melody.note, dur, time, plan.melody.velocity);
    }
    if (plan.drop) {
      this._applyChannelGain('rain');
      this.nodes.drops.triggerAttackRelease(plan.drop.note, 0.05, time, plan.drop.velocity);
    }
    if (plan.pad) {
      this._applyChannelGain('ice');
      this.nodes.pad.triggerAttackRelease(plan.pad.notes, STEPS_PER_BAR * stepSeconds * 1.1, time, plan.pad.velocity);
    }
    this.stepIndex += 1;
  }

  _disposeNodes() {
    if (!this.nodes) return;
    this.nodes.piano.dispose();
    this.nodes.drops.dispose();
    this.nodes.pad.dispose();
    for (const g of Object.values(this.nodes.gains)) g.dispose();
    this.nodes = null;
    this.gainState = {};
  }

  dispose() {
    this.stop();
    this._disposeNodes();
    this.pending = {};
    this.latched = {};
  }
}
