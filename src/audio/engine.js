import * as Tone from 'tone';
import { AUDIO_SAFETY } from '../config/sonification.js';
import { anomalyToNote } from './mapping.js';

const DUCK_OFFSET_DB = -14; // atenuacion temporal mientras se narra una historia

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Motor de audio minimo: un unico synth reutilizado (nunca se crea uno
 * nuevo por nota), encadenado a una ganancia conservadora y un limiter
 * explicito. Tone solo se arranca con un gesto de usuario (start()), nunca
 * automaticamente.
 *
 * Invariantes reforzadas tras revision:
 *  - start() es idempotente ante llamadas concurrentes: una segunda llamada
 *    mientras la primera esta en vuelo espera la MISMA promesa en vez de
 *    construir un segundo synth/gain/limiter.
 *  - El mute/volumen preseleccionados (antes de start()) se aplican AL
 *    CONSTRUIR el nodo de ganancia, antes de encadenarlo/conectarlo, para
 *    que nunca haya una ventana donde el audio salga al volumen por
 *    defecto ignorando un mute ya pedido por el usuario.
 *  - Mutear corta inmediatamente cualquier nota sostenida (triggerRelease)
 *    y bloquea playAnomaly mientras este muteado, para que un unmute
 *    posterior nunca "revele" el final de una nota que debio haberse
 *    cortado.
 *  - playAnomaly nunca lanza por timestamps repetidos/no crecientes: el
 *    motor mantiene el ultimo tiempo de disparo y fuerza monotonicidad.
 */
export class AudioEngine {
  constructor({ ToneLib = Tone } = {}) {
    this.Tone = ToneLib;
    this.started = false;
    this.startPromise = null;
    this.muted = false;
    this.ducked = false;
    this.volumeDb = clamp(AUDIO_SAFETY.masterGainDb, AUDIO_SAFETY.volumeDbMin, AUDIO_SAFETY.volumeDbMax);
    this.synth = null;
    this.gain = null;
    this.limiter = null;
    this.lastNoteTime = null;
  }

  isStarted() {
    return this.started;
  }

  isMuted() {
    return this.muted;
  }

  /**
   * Bus de entrada compartido (pre-gain/mute/limiter/destino) para que
   * fuentes adicionales (p.ej. DjMixer, ver audio/mixer.js) se conecten
   * SIN crear un segundo camino de salida ni saltarse el limiter/mute/
   * volumen global. Solo valido una vez iniciado (ver isStarted()).
   */
  getBus() {
    return this.gain;
  }

  /** Idempotente: llamadas concurrentes comparten la misma promesa en vuelo. */
  async start() {
    if (this.started) return;
    if (!this.startPromise) {
      this.startPromise = this._doStart().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  async _doStart() {
    await this.Tone.start();
    if (this.started) return; // ya arrancado por otra llamada concurrente
    const limiter = new this.Tone.Limiter(AUDIO_SAFETY.limiterThresholdDb);
    // El gain se crea YA con el valor objetivo (mute/volumen preseleccionados
    // antes del gesto de usuario que dispara start()), antes de encadenar.
    const gain = new this.Tone.Gain(this.Tone.dbToGain(this._targetGainDb()));
    const synth = new this.Tone.Synth({
      envelope: {
        attack: AUDIO_SAFETY.attackSeconds,
        release: AUDIO_SAFETY.releaseSeconds
      }
    });
    synth.chain(gain, limiter, this.Tone.Destination);
    this.limiter = limiter;
    this.gain = gain;
    this.synth = synth;
    this.started = true;
  }

  _targetGainDb() {
    if (this.muted) return -Infinity;
    const db = this.ducked ? this.volumeDb + DUCK_OFFSET_DB : this.volumeDb;
    return clamp(db, -Infinity, AUDIO_SAFETY.volumeDbMax);
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.muted && this.synth) {
      // Corta cualquier nota sostenida ya mismo: evita que un unmute
      // posterior revele el final de una envolvente pendiente.
      this.synth.triggerRelease(this.Tone.now());
    }
    this._applyGain();
  }

  /**
   * Reduce temporalmente la musica (p.ej. mientras se narra una historia)
   * sin tocar el estado de mute del usuario. restaurar() = setDucked(false).
   */
  setDucked(ducked) {
    this.ducked = Boolean(ducked);
    this._applyGain();
  }

  setVolumeDb(db) {
    if (typeof db !== 'number' || !Number.isFinite(db)) return; // se ignora, nunca se acepta sin validar
    this.volumeDb = clamp(db, AUDIO_SAFETY.volumeDbMin, AUDIO_SAFETY.volumeDbMax);
    this._applyGain();
  }

  _applyGain() {
    if (!this.gain) return;
    const targetDb = this._targetGainDb();
    const targetGain = targetDb === -Infinity ? 0 : this.Tone.dbToGain(targetDb);
    this.gain.gain.rampTo(targetGain, 0.05);
  }

  /**
   * Reproduce la anomalia dada como una nota. No hace nada si no hay dato,
   * si el motor no ha arrancado o si esta muteado (el mute bloquea
   * explicitamente nuevas notas, no solo atenua la salida).
   */
  playAnomaly(value) {
    if (!this.started || !this.synth || this.muted) return null;
    const note = anomalyToNote(value);
    if (!note) return null;
    const now = this.Tone.now();
    // El synth es monofonico: dos disparos con el mismo timestamp (o uno no
    // creciente) lanzarian en Tone.js. Se fuerza un tiempo estrictamente
    // posterior al ultimo disparo en vez de pasar `now` crudo.
    const time = this.lastNoteTime !== null && now <= this.lastNoteTime ? this.lastNoteTime + 0.001 : now;
    this.synth.triggerAttackRelease(note, AUDIO_SAFETY.noteDurationSeconds, time);
    this.lastNoteTime = time;
    return note;
  }

  dispose() {
    this.synth?.dispose();
    this.gain?.dispose();
    this.limiter?.dispose();
    this.started = false;
    this.startPromise = null;
    this.lastNoteTime = null;
  }
}
