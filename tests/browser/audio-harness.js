// Harness de verificacion de audio REAL contra los modulos de PRODUCCION
// (src/audio/engine.js, src/audio/mixer.js), renderizado con Tone.Offline
// (OfflineAudioContext real, no un mock). Ver docs/audio-verification.md
// para la explicacion completa de la adaptacion necesaria para que
// Tone.Offline funcione con estas clases sin tocar su codigo, incluyendo
// un hallazgo real (no documentado por Tone.js) descubierto al construir
// este harness.
import * as Tone from 'tone';
import { AudioEngine } from '../../src/audio/engine.js';
import { DjMixer } from '../../src/audio/mixer.js';
import { PENTATONIC_SCALE } from '../../src/config/sonification.js';

// --- Adaptacion REAL necesaria (ver docs/audio-verification.md) ----------
// AudioEngine/DjMixer usan `this.Tone.Transport`/`this.Tone.Destination`.
// Pasando el modulo `Tone` tal cual como `ToneLib`, estas dos propiedades
// son los exports ESTATICOS @deprecated de Tone.js (capturados UNA vez
// cuando 'tone' se evalua, apuntando al contexto EN VIVO original): dentro
// de Tone.Offline() nunca se actualizan, asi que claramente no sirven.
//
// HALLAZGO REAL (no advertido por la documentacion de Tone.js, confirmado
// leyendo node_modules/tone/Tone/core/context/Offline.ts): un primer
// intento de arreglarlo con una propiedad CALCULADA dinamicamente
// (`get Transport() { return Tone.getTransport(); }`, el patron que el
// propio Tone.js recomienda como reemplazo del export estatico) SIGUE
// FALLANDO de una forma sutil y especifica a Offline: `Offline()` llama
// `setContext(originalContext)` INMEDIATAMENTE despues de invocar
// `context.render()`, SIN esperar a que el render termine (ver Offline.ts
// lineas ~56-61). El render en si (`context.render()`) sigue en curso de
// forma asincrona DESPUES de ese punto. Cualquier callback de Transport
// (p.ej. un `scheduleOnce`/`scheduleRepeat`) que se ejecute DURANTE esa
// fase de render tardio, si llama a `Tone.getTransport()` dinamicamente en
// ese momento, obtiene el Transport del contexto EN VIVO ORIGINAL (ya
// restaurado), NO el del contexto offline que todavia se esta grabando.
// `Transport.clear(id)`/`.stop()` llamados sobre ese Transport equivocado
// no tienen ningun efecto sobre el render offline real: los eventos
// "fantasma" siguen sonando indefinidamente. Se reprodujo en un caso
// minimo (ver tests/audio-offline.test.mjs) ANTES de aplicar esta
// correccion: con la propiedad calculada, `scheduleRepeat` + `clear()` NO
// detenia los ticks despues de limpiarlos; con una referencia CAPTURADA
// una sola vez SI los detenia correctamente.
//
// Correccion real: el callback que Tone.Offline() invoca recibe como
// parametro el `OfflineContext` real (`context.transport`/
// `context.destination`, ver Offline.ts/Context.ts). Capturando esas
// referencias UNA SOLA VEZ, de forma sincrona, dentro del callback (antes
// de que exista ningun `await`/callback futuro), y construyendo el
// `ToneLib` con esas referencias como propiedades de DATOS normales (no
// getters), el resto del codigo de produccion (que SOLO necesita que
// `this.Tone.Transport`/`this.Tone.Destination` sean el objeto correcto,
// nunca vuelve a pedirlo "de nuevo" de forma dinamica) funciona sin
// ninguna modificacion. Esto NO es un mock de audio: los nodos, sintes,
// limitador y Transport siguen siendo instancias REALES de Tone.js,
// conectadas al OfflineAudioContext real.
//
// SEGUNDO HALLAZGO REAL (revision posterior, confirmado leyendo
// node_modules/tone/Tone/index.ts): el mismo problema de "contexto global
// ya restaurado durante el render tardio" afecta tambien a `Tone.now()` y
// `Tone.Time(...)`, aunque estas SI son funciones dinamicas (no exports
// estaticos como Transport/Destination): `now()` hace
// `getContext().now()` y el factory `Time(...)` construye un
// `TimeClass` ligado a `getContext()` EN EL MOMENTO EN QUE SE LLAMAN. Si
// esa llamada ocurre dentro de un callback de Transport que se ejecuta
// DURANTE la fase tardia del render (offline ya restaurado al contexto
// original), devuelven el tiempo/Time del contexto EN VIVO equivocado,
// no el offline. Efecto real observado: DjMixer._onPulse llama
// `this.Tone.Time('4n').toSeconds()` para calcular el intervalo del pulso
// compartido -> con el Time del contexto equivocado, toSeconds() usaba el
// BPM por defecto (120) del Transport en vivo, no el BPM real (48-96)
// configurado en el Transport OFFLINE; y DjMixer.stop()/
// AudioEngine.setMuted() llaman `this.Tone.now()` para fijar el tiempo de
// triggerRelease, tambien con el reloj equivocado.
//
// Correccion: igual que Transport/Destination, `now`/`Time` se fijan como
// funciones que SIEMPRE delegan en el `offlineContext` ya capturado
// (`offlineContext.now()`, `new Tone.TimeClass(offlineContext, value,
// units)` — firma real confirmada en
// node_modules/tone/Tone/core/type/TimeBase.ts linea 78:
// `constructor(context, value, units)`), nunca en `Tone.now`/`Tone.Time`
// dinamicos. Sigue sin ser un mock: `TimeClass` es la clase real de
// Tone.js, solo que construida explicitamente sobre el contexto correcto.
function makeOfflineToneLib(offlineContext) {
  return {
    ...Tone,
    Transport: offlineContext.transport,
    Destination: offlineContext.destination,
    now: () => offlineContext.now(),
    Time: (value, units) => new Tone.TimeClass(offlineContext, value, units)
  };
}

// Adapter DELIBERADAMENTE ROTO, SOLO para el control negativo del test de
// BPM (ver rainOnsetTimes({ brokenTimeAdapter: true })). Desde la version
// musical 2 el mezclador ya no usa Tone.Time() (agenda con scheduleRepeat
// '16n' sobre el Transport), asi que el bug original de Time ya no puede
// reproducirse; el control reproduce su EFECTO: el pulso queda en el BPM por
// defecto del contexto en vivo (120) e ignora el BPM configurado. Transport/
// Destination/now SI quedan correctos. NO se usa en ningun test que afirme
// verificar produccion: prueba que el detector distingue "BPM correcto" de
// "BPM 120 por defecto".
function makeBrokenTimeToneLib(offlineContext) {
  const real = offlineContext.transport;
  const brokenTransport = {
    scheduleRepeat: (...args) => real.scheduleRepeat(...args),
    scheduleOnce: (...args) => real.scheduleOnce(...args),
    clear: (...args) => real.clear(...args),
    start: (...args) => real.start(...args),
    stop: (...args) => real.stop(...args),
    bpm: {
      get value() {
        return real.bpm.value;
      },
      set value(_ignored) {
        /* BUG DELIBERADO: el BPM configurado se ignora */
      }
    }
  };
  return {
    ...Tone,
    Transport: brokenTransport,
    Destination: offlineContext.destination,
    now: () => offlineContext.now(),
    Time: (value, units) => new Tone.TimeClass(offlineContext, value, units)
  };
}

function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function peak(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const a = Math.abs(buf[i]);
    if (a > m) m = a;
  }
  return m;
}

function allFinite(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (!Number.isFinite(buf[i])) return false;
  }
  return true;
}

// Goertzel: magnitud de UNA frecuencia candidata en una ventana, sin
// necesitar una libreria de FFT completa. Suficiente porque conocemos de
// antemano el conjunto FINITO de notas posibles (escala pentatonica fija,
// ver config/sonification.js): basta comparar la magnitud en cada nota
// candidata y quedarse con la mayor (deteccion de tono real por energia
// espectral, no una lectura humana).
function goertzelMagnitude(buf, sampleRate, freq) {
  const n = buf.length;
  const k = Math.round((n * freq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i += 1) {
    const q0 = coeff * q1 - q2 + buf[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * Math.cos(omega);
  const imag = q2 * Math.sin(omega);
  return Math.sqrt(real * real + imag * imag) / (n / 2);
}

const NOTE_FREQS = PENTATONIC_SCALE.map((note) => ({ note, freq: Tone.Frequency(note).toFrequency() }));

function dominantNote(buf, sampleRate) {
  let best = null;
  let bestFreq = null;
  let bestMag = -1;
  for (const { note, freq } of NOTE_FREQS) {
    const mag = goertzelMagnitude(buf, sampleRate, freq);
    if (mag > bestMag) {
      bestMag = mag;
      best = note;
      bestFreq = freq;
    }
  }
  return { note: best, freq: bestFreq, magnitude: bestMag };
}

function toMono(toneBuffer) {
  const raw = toneBuffer.get();
  const ch0 = raw.getChannelData(0);
  if (raw.numberOfChannels > 1) {
    const ch1 = raw.getChannelData(1);
    const mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i += 1) mono[i] = (ch0[i] + ch1[i]) / 2;
    return { mono, sampleRate: raw.sampleRate, raw };
  }
  return { mono: ch0, sampleRate: raw.sampleRate, raw };
}

// Deteccion simple de "hits" por onset: energia RMS en ventanas pequenas
// (10ms), un hit = una ventana cuya energia sube por encima de un umbral
// absoluto Y de un salto relativo respecto a la ventana anterior (evita
// contar un unico ataque largo como varios hits).
function countOnsets(buf, sampleRate, { windowMs = 10, floor = 0.001, jump = 1.5 } = {}) {
  const windowSize = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));
  const energies = [];
  for (let start = 0; start < buf.length; start += windowSize) {
    energies.push(rms(buf.subarray(start, start + windowSize)));
  }
  let hits = 0;
  let wasAbove = false;
  for (let i = 0; i < energies.length; i += 1) {
    const prev = i > 0 ? energies[i - 1] : 0;
    const isOnset = energies[i] > floor && energies[i] > prev * jump;
    if (isOnset && !wasAbove) hits += 1;
    wasAbove = energies[i] > floor;
  }
  return hits;
}

window.AudioHarness = {
  async pingOffline() {
    const buffer = await Tone.Offline(() => {
      const osc = new Tone.Oscillator(440, 'sine').toDestination();
      osc.start(0).stop(0.5);
    }, 0.6);
    const { mono } = toMono(buffer);
    return { rms: rms(mono), finite: allFinite(mono) };
  },

  /** AudioEngine.playAnomaly real, una nota por render (aislada). */
  async temperatureNote(anomaly) {
    const buffer = await Tone.Offline((offlineContext) => {
      const ToneLib = makeOfflineToneLib(offlineContext);
      const engine = new AudioEngine({ ToneLib });
      return engine.start().then(() => {
        engine.setMuted(false);
        engine.setVolumeDb(0);
        engine.playAnomaly(anomaly);
      });
    }, 1.2);
    const { mono, sampleRate } = toMono(buffer);
    const { note, freq, magnitude } = dominantNote(mono, sampleRate);
    return { anomaly, note, freq, magnitude, rms: rms(mono), peak: peak(mono), finite: allFinite(mono) };
  },

  /**
   * Igual que temperatureNote, pero devuelve la FORMA DE ONDA CRUDA
   * (no solo el resultado de Goertzel sobre notas candidatas): permite
   * que el lado Python haga su PROPIA FFT (numpy.fft) independiente,
   * buscando el pico espectral general sin limitarse a un conjunto
   * predeterminado de frecuencias candidatas (la nota pentatonica
   * esperada es la hipotesis a confirmar, no un valor que la propia
   * medicion ya asuma).
   */
  async temperatureNoteRaw(anomaly) {
    const buffer = await Tone.Offline((offlineContext) => {
      const ToneLib = makeOfflineToneLib(offlineContext);
      const engine = new AudioEngine({ ToneLib });
      return engine.start().then(() => {
        engine.setMuted(false);
        engine.setVolumeDb(0);
        engine.playAnomaly(anomaly);
      });
    }, 1.2);
    const { mono, sampleRate } = toMono(buffer);
    return { anomaly, sampleRate, samples: Array.from(mono) };
  },

  /**
   * Confirma mute=0 (epsilon estricto) con el DJ CONTINUO sonando sobre un
   * Transport REALMENTE arrancado (bug real corregido: la version
   * anterior agendaba `Transport.scheduleOnce(muted, 0.3)` sin llamar
   * `Transport.start()` en ningun lado -> el callback de mute NUNCA se
   * ejecutaba, y la "ventana muteada" en realidad solo medía el final
   * natural (release) de una nota ya terminada, no un mute real: falso
   * positivo). Ahora: DjMixer.start() (que SI llama Transport.start())
   * mantiene temperatura sonando pulso tras pulso; se renderiza dos veces
   * la MISMA escena (control sin mutear vs. muteada) para poder comparar
   * "hubiera sonado" contra "mutea de verdad", en vez de asumir un nivel
   * absoluto fijo.
   */
  async muteAfterRamp() {
    const bpm = 120; // pulso rapido (0.5s) para tener varias notas dentro de la ventana de prueba
    const duration = 3.0;
    const muteAtSec = 0.6; // despues de al menos un pulso ya sonado
    const rampSec = 0.05; // AUDIO_SAFETY: _applyGain usa rampTo(..., 0.05)
    const postRampStart = muteAtSec + rampSec + 0.05; // margen de seguridad sobre la rampa

    let muteCallbackFired = false;
    let isMutedAfterCallback = null;

    async function renderScene(shouldMute) {
      return Tone.Offline((offlineContext) => {
        const ToneLib = makeOfflineToneLib(offlineContext);
        const engine = new AudioEngine({ ToneLib });
        return engine.start().then(() => {
          engine.setMuted(false);
          engine.setVolumeDb(0);
          const mixer = new DjMixer({ ToneLib, bus: engine.getBus(), seed: 'mute-harness', bpm });
          mixer.setChannel('rain', { enabled: false });
          mixer.setChannel('ice', { enabled: false });
          mixer.updateData({ temperature: 4 }); // nota fija en CADA pulso, nunca null
          mixer.start(); // DjMixer.start() llama Transport.start() de verdad
          if (shouldMute) {
            ToneLib.Transport.scheduleOnce(() => {
              engine.setMuted(true);
              muteCallbackFired = true;
              isMutedAfterCallback = engine.isMuted();
            }, muteAtSec);
          }
        });
      }, duration);
    }

    const controlBuffer = await renderScene(false); // mismo escenario, SIN mutear (referencia "hubiera sonado")
    const mutedBuffer = await renderScene(true);

    const { mono: controlMono, sampleRate } = toMono(controlBuffer);
    const { mono: mutedMono } = toMono(mutedBuffer);
    const postRampStartSample = Math.floor(postRampStart * sampleRate);
    const controlWindow = controlMono.subarray(postRampStartSample, controlMono.length);
    const mutedWindow = mutedMono.subarray(postRampStartSample, mutedMono.length);

    return {
      muteCallbackFired,
      isMutedAfterCallback,
      controlRms: rms(controlWindow),
      controlPeak: peak(controlWindow),
      mutedRms: rms(mutedWindow),
      mutedPeak: peak(mutedWindow),
      finite: allFinite(controlMono) && allFinite(mutedMono)
    };
  },

  /** Hielo en solo: una fraccion por render, UN pulso del transporte. */
  async iceSingle(fraction) {
    const bpm = 60; // 1 pulso ('4n') = 1s exacto, facil de acotar en ventanas
    const buffer = await Tone.Offline((offlineContext) => {
      const ToneLib = makeOfflineToneLib(offlineContext);
      const engine = new AudioEngine({ ToneLib });
      return engine.start().then(() => {
        const mixer = new DjMixer({ ToneLib, bus: engine.getBus(), seed: 'ice-harness', bpm });
        mixer.setChannel('temperature', { enabled: false });
        mixer.setChannel('rain', { enabled: false });
        mixer.setChannel('ice', { enabled: true, solo: true });
        mixer.updateData({ ice: fraction });
        mixer.start();
      });
    }, 1.6);
    const { mono, sampleRate } = toMono(buffer);
    const window_ = mono.subarray(0, Math.floor(1.5 * sampleRate));
    return { fraction, rms: rms(window_), peak: peak(window_), finite: allFinite(mono) };
  },

  /** Lluvia en solo: semilla fija, N pulsos, cuenta de "hits" reales. */
  async rainHits(rainValue, seed = 'rain-harness') {
    const bpm = 72;
    const pulses = 8;
    const duration = pulses * (60 / bpm) + 1.0;
    const buffer = await Tone.Offline((offlineContext) => {
      const ToneLib = makeOfflineToneLib(offlineContext);
      const engine = new AudioEngine({ ToneLib });
      return engine.start().then(() => {
        const mixer = new DjMixer({ ToneLib, bus: engine.getBus(), seed, bpm });
        mixer.setChannel('temperature', { enabled: false });
        mixer.setChannel('ice', { enabled: false });
        mixer.setChannel('rain', { enabled: true, solo: true });
        mixer.updateData({ rain: rainValue });
        mixer.start();
      });
    }, duration);
    const { mono, sampleRate } = toMono(buffer);
    return { rainValue, hits: countOnsets(mono, sampleRate), finite: allFinite(mono) };
  },

  /**
   * Igual que rainHits, pero devuelve los TIEMPOS reales de cada onset
   * (no solo el conteo), con resolucion de deteccion de 5ms: permite
   * verificar que el intervalo FUNDAMENTAL entre subdivisiones escala con
   * el BPM real del Transport OFFLINE (bug real corregido: antes de la
   * correccion de `Time`, `_onPulse` calculaba el offset de cada
   * subdivision con el BPM por defecto del contexto EN VIVO (120), no con
   * el BPM offline configurado aqui).
   *
   * `brokenTimeAdapter: true` usa DELIBERADAMENTE el adapter roto
   * (`makeBrokenTimeToneLib`, ver arriba) como CONTROL NEGATIVO: el valor
   * devuelto debe reflejar el BPM en vivo incorrecto (120), nunca el bpm
   * pedido, demostrando que esta misma medicion SI tiene poder para
   * detectar la regresion (no solo "cabe en un limite superior").
   */
  async rainOnsetTimes(bpm, rainValue, seed = 'rain-harness-intervals', { brokenTimeAdapter = false } = {}) {
    const pulses = 8;
    const duration = pulses * (60 / bpm) + 1.0;
    const buffer = await Tone.Offline((offlineContext) => {
      const ToneLib = brokenTimeAdapter ? makeBrokenTimeToneLib(offlineContext) : makeOfflineToneLib(offlineContext);
      const engine = new AudioEngine({ ToneLib });
      return engine.start().then(() => {
        const mixer = new DjMixer({ ToneLib, bus: engine.getBus(), seed, bpm });
        mixer.setChannel('temperature', { enabled: false });
        mixer.setChannel('ice', { enabled: false });
        mixer.setChannel('rain', { enabled: true, solo: true });
        mixer.updateData({ rain: rainValue });
        mixer.start();
      });
    }, duration);
    const { mono, sampleRate } = toMono(buffer);
    const windowMs = 5;
    const windowSize = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));
    const floor = 0.001;
    const jump = 1.5;
    const onsetTimesSec = [];
    let prevEnergy = 0;
    let wasAbove = false;
    for (let start = 0; start < mono.length; start += windowSize) {
      const energy = rms(mono.subarray(start, start + windowSize));
      const isOnset = energy > floor && energy > prevEnergy * jump;
      if (isOnset && !wasAbove) onsetTimesSec.push(start / sampleRate);
      wasAbove = energy > floor;
      prevEnergy = energy;
    }
    return { bpm, rainValue, pulseSec: 60 / bpm, onsetTimesSec, finite: allFinite(mono) };
  },

  /**
   * stop() fuerza triggerRelease y Transport.clear(scheduleId) (ver
   * audio/mixer.js): confirma que NINGUN pulso nuevo vuelve a sonar
   * despues de stop() (nada de loop infinito), mas alla de la cola de
   * release de la ULTIMA nota ya disparada antes de stop() (decaimiento
   * ADSR normal, no un bug: la misma nota decae igual en vivo). Se deja
   * pasar el peor caso de esa cola (hielo: duracion '2n' + release 1.0s,
   * el canal mas largo) antes de buscar onsets nuevos.
   */
  async stopCutsLoopedAudio() {
    const bpm = 72;
    const pulseSec = 60 / bpm;
    const stopAfterPulses = 3;
    const stopTimeSec = stopAfterPulses * pulseSec + 0.05; // margen: pulso 3 SI dispara antes de stop()
    const maxTailSec = pulseSec * 2 + 1.0; // '2n' (hielo) + su release
    const verifyWindowSec = pulseSec * 4; // suficiente para detectar pulsos fantasma si los hubiera
    const duration = stopTimeSec + maxTailSec + verifyWindowSec;
    const buffer = await Tone.Offline((offlineContext) => {
      const ToneLib = makeOfflineToneLib(offlineContext);
      const engine = new AudioEngine({ ToneLib });
      return engine.start().then(() => {
        const mixer = new DjMixer({ ToneLib, bus: engine.getBus(), seed: 'stop-harness', bpm });
        mixer.updateData({ temperature: 3, rain: 15, ice: 0.6 });
        mixer.start();
        ToneLib.Transport.scheduleOnce(() => mixer.stop(), stopTimeSec);
      });
    }, duration);
    const { mono, sampleRate } = toMono(buffer);
    const verifyStartSec = stopTimeSec + maxTailSec;
    const afterTail = mono.subarray(Math.floor(verifyStartSec * sampleRate), mono.length);
    return {
      onsetsAfterStopTail: countOnsets(afterTail, sampleRate, { floor: 0.0005 }),
      rmsAfterStopTail: rms(afterTail),
      finite: allFinite(mono)
    };
  },

  /**
   * Composicion finita REAL (mezclador de produccion en modo 'composition',
   * 8 compases a 96 BPM). Devuelve la forma de onda estereo, el instante en
   * que se llamo onEnd (Tone.now() del contexto offline) y la duracion
   * renderizada. renderSeconds incluye la cola natural de release.
   * stopAtSec / nullAtSec: acciones agendadas en el Transport offline.
   */
  async compositionMix({
    temperatureAnomalyK = null,
    rainMmDay = null,
    iceFraction = null,
    seed = 'demo-wav-2023-12-arctic',
    renderSeconds = 22.5,
    stopAtSec = null,
    nullAtSec = null,
    changeTemperatureAt = null,
    changeTemperatureTo = null,
    returnChannels = true
  } = {}) {
    let endedAt = null;
    let ended = false;
    const buffer = await Tone.Offline((offlineContext) => {
      const ToneLib = makeOfflineToneLib(offlineContext);
      const engine = new AudioEngine({ ToneLib });
      return engine.start().then(() => {
        const mixer = new DjMixer({ ToneLib, bus: engine.getBus(), seed });
        mixer.updateData({ temperature: temperatureAnomalyK, rain: rainMmDay, ice: iceFraction });
        mixer.start({
          mode: 'composition',
          onEnd: () => {
            ended = true;
            endedAt = ToneLib.now();
          }
        });
        if (stopAtSec !== null) ToneLib.Transport.scheduleOnce(() => mixer.stop(), stopAtSec);
        if (nullAtSec !== null) {
          ToneLib.Transport.scheduleOnce(() => mixer.updateData({ temperature: null, rain: null, ice: null }), nullAtSec);
        }
        if (changeTemperatureAt !== null) {
          ToneLib.Transport.scheduleOnce(() => mixer.updateData({ temperature: changeTemperatureTo }), changeTemperatureAt);
        }
      });
    }, renderSeconds);
    const raw = buffer.get();
    const left = raw.getChannelData(0);
    const right = raw.numberOfChannels > 1 ? raw.getChannelData(1) : left;
    const result = {
      sampleRate: raw.sampleRate,
      numberOfChannels: raw.numberOfChannels,
      length: left.length,
      ended,
      endedAt,
      peak: Math.max(peak(left), peak(right)),
      finite: allFinite(left) && allFinite(right),
      meta: { temperatureAnomalyK, rainMmDay, iceFraction, seed, renderSeconds, stopAtSec, nullAtSec, changeTemperatureAt, changeTemperatureTo }
    };
    if (returnChannels) {
      result.channels = [Array.from(left), raw.numberOfChannels > 1 ? Array.from(right) : Array.from(left)];
    } else {
      result.mono = Array.from(left);
    }
    return result;
  },

  /**
   * Ciclo de vida con el pad (hielo) sostenido, mezclador de PRODUCCION:
   * acciones agendadas en el Transport offline. op: 'null' (updateData ice
   * null), 'stop', 'rerender' (setChannel con la MISMA config, como hace
   * dj-panel.render en cada store.set). Sin acciones = control continuo.
   */
  async lifecycleScenario({ actions = [], renderSeconds = 6.0, useClock = false } = {}) {
    let endedAt = null;
    const buffer = await Tone.Offline((offlineContext) => {
      const ToneLib = makeOfflineToneLib(offlineContext);
      const engine = new AudioEngine({ ToneLib });
      return engine.start().then(() => {
        const mixer = new DjMixer({ ToneLib, bus: engine.getBus(), seed: 'lifecycle' });
        const run = (a) => {
          if (a.op === 'null') mixer.updateData({ ice: null });
          else if (a.op === 'stop') mixer.stop();
          else if (a.op === 'rerender') mixer.setChannel('ice', { enabled: true, gainDb: -6, solo: false });
        };
        mixer.setChannel('temperature', { enabled: false });
        mixer.setChannel('rain', { enabled: false });
        mixer.updateData({ ice: 1 });
        mixer.start({
          mode: 'composition',
          onEnd: () => {
            endedAt = ToneLib.now();
            // El Transport ya esta parado: las acciones posteriores al fin usan el reloj del contexto.
            for (const a of actions.filter((x) => x.afterEnd)) offlineContext.setTimeout(() => run(a), a.t);
          }
        });
        for (const a of actions.filter((x) => !x.afterEnd)) {
          if (useClock) offlineContext.setTimeout(() => run(a), a.t);
          else ToneLib.Transport.scheduleOnce(() => run(a), a.t);
        }
      });
    }, renderSeconds);
    const raw = buffer.get();
    return { sampleRate: raw.sampleRate, endedAt, samples: Array.from(raw.getChannelData(0)) };
  },

  /** Muestras (mono) de la composicion; para analisis espectral del lado Python. */
  async compositionMono(params) {
    const r = await window.AudioHarness.compositionMix({ ...params, returnChannels: false });
    const { mono, ...rest } = r;
    return { ...rest, samples: mono };
  }
};

window.__audioHarnessReady = true;
