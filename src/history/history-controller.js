// Controlador de "Tu historia con la Tierra": consulta atomica de las dos
// epocas y reproduccion antes/despues (o secuencia automatica opt-in) con el
// mismo mezclador, semilla, estilo, tempo, ganancia y duracion. Sin DOM: la
// pestana (ui/history-panel.js) solo pinta el estado y llama estos metodos.
//
// Cancelacion: una consulta nueva, salir de la pestana, Detener, silencio
// global, o cualquier cambio del borrador (lugar/fecha) o accion directa del
// usuario sobre globo/linea de tiempo (cancelQuery) invalidan (token)
// cualquier carga, temporizador o audio pendiente ANTES de que escriba en el
// store. Cada epoca espera a que el globo/linea de tiempo confirmen su
// periodo (onShowEpoch devuelve una promesa) antes de sonar. Sin autoplay.
import { createHistoryState } from '../state/store.js';
import { createActionCoordinator, runGuardedAction } from '../app/action-coordinator.js';
import {
  validateBirth,
  validatePlace,
  loadHistoryResult,
  epochAnnouncement,
  buildStory
} from './history-core.js';

export const EPOCH_GAP_MS = 1000;

export function createHistoryController({
  store,
  repository,
  audioEngine,
  narrator,
  createMixer,
  onShowPoint,
  onShowEpoch,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = (id) => clearTimeout(id),
  gapMs = EPOCH_GAP_MS
}) {
  const coordinator = createActionCoordinator();
  let playToken = 0;
  let gapTimer = null;
  let mixer = null;

  function patch(fields) {
    store.set((s) => ({ history: { ...s.history, ...fields } }));
  }

  function latestPeriod() {
    const periods = repository.availablePeriods;
    return periods[periods.length - 1] ?? null;
  }

  function silence() {
    playToken += 1;
    if (gapTimer !== null) {
      clearTimeoutFn(gapTimer);
      gapTimer = null;
    }
    mixer?.stop();
    narrator?.cancel();
  }

  /** Corta audio/voz/temporizadores. No toca la consulta ni el resultado. */
  function stop() {
    const wasActive = store.get().history.playing !== null;
    silence();
    if (wasActive || store.get().history.playError) patch({ playing: null, ended: false, playError: null });
  }

  function ensureMixer() {
    if (!mixer) {
      mixer = createMixer();
      mixer.setChannel('rain', { enabled: false });
      mixer.setChannel('ice', { enabled: false });
    }
    return mixer;
  }

  function canSound(s) {
    if (!s.history.result || s.history.status !== 'ready') return 'noResult';
    if (!audioEngine.isStarted()) return 'audioOff';
    if (s.audio.muted) return 'muted';
    if (s.activeTab !== 'history') return 'tab';
    return null;
  }

  function abortPlay(extra = {}) {
    patch({ playing: null, ended: false, ...extra });
  }

  async function beginEpoch(which, auto, kind) {
    const s0 = store.get();
    const blocked = canSound(s0);
    if (blocked) return { ok: false, reason: blocked };
    const epoch = s0.history.result[which];
    if (epoch.value === null) return { ok: false, reason: 'noData' };
    silence();
    const token = playToken;
    patch({ playing: { epoch: which, auto, phase: 'loading' }, lastPlay: kind, ended: false, playError: null });

    // El globo y la linea de tiempo deben confirmar ESTA epoca antes de que
    // suene o hable nada; un fallo o una orden posterior no deja musica tardia.
    let shown = { ok: true };
    if (onShowEpoch) {
      try {
        shown = (await onShowEpoch(epoch.period)) ?? { ok: true };
      } catch {
        shown = { ok: false, reason: 'error' };
      }
    }
    if (token !== playToken) return { ok: false, reason: 'stale' };
    if (!shown.ok) {
      abortPlay({ playError: 'epoch' });
      return { ok: false, reason: 'epochError' };
    }
    const s = store.get();
    const stillBlocked = canSound(s);
    if (stillBlocked) {
      abortPlay();
      return { ok: false, reason: stillBlocked };
    }
    try {
      const m = ensureMixer();
      m.setSeed(s.dj.seed || 'earth-jukebox');
      m.updateData({ temperature: epoch.value, rain: null, ice: null });
      patch({ playing: { epoch: which, auto, phase: 'music' } });
      if (s.history.voice) narrator?.speak(epochAnnouncement(s.history.result, which, s.lang), s.lang);
      m.start({ mode: 'composition', onEnd: () => handleEnd(which, auto, token) });
    } catch (err) {
      console.error('No se pudo iniciar la escucha', err);
      silence();
      abortPlay({ playError: 'start' });
      return { ok: false, reason: 'startError' };
    }
    return { ok: true };
  }

  function handleEnd(which, auto, token) {
    if (token !== playToken) return;
    if (auto && which === 'a') {
      patch({ playing: { epoch: 'b', auto: true, phase: 'gap' } });
      gapTimer = setTimeoutFn(() => {
        gapTimer = null;
        if (token !== playToken) return undefined;
        return beginEpoch('b', true, 'auto').then((started) => {
          const failedWithState = ['stale', 'epochError', 'startError'].includes(started.reason);
          if (!started.ok && !failedWithState) patch({ playing: null, ended: true });
          return started;
        });
      }, gapMs);
      return;
    }
    patch({ playing: null, ended: true });
  }

  async function play(which) {
    if (which !== 'a' && which !== 'b') return { ok: false, reason: 'invalid' };
    return beginEpoch(which, false, which);
  }

  async function playAuto() {
    const result = store.get().history.result;
    if (!result) return { ok: false, reason: 'noResult' };
    if (result.a.value === null || result.b.value === null) return { ok: false, reason: 'noData' };
    return beginEpoch('a', true, 'auto');
  }

  async function repeat() {
    const last = store.get().history.lastPlay;
    if (last === 'auto') return playAuto();
    if (last === 'a' || last === 'b') return play(last);
    return { ok: false, reason: 'nothing' };
  }

  function setVoice(enabled) {
    patch({ voice: Boolean(enabled) });
    if (!enabled) narrator?.cancel();
  }

  /** Lee el relato completo con voz: accion explicita (opt-in), respeta mute. */
  function speakStory() {
    const s = store.get();
    const result = s.history.result;
    if (!result) return { ok: false, reason: 'noResult' };
    if (s.audio.muted) return { ok: false, reason: 'muted' };
    if (!narrator?.isSupported()) return { ok: false, reason: 'unsupported' };
    silence();
    patch({ playing: null, ended: false });
    narrator.speak(buildStory(result, s.lang, { latestPeriod: latestPeriod() }).join(' '), s.lang);
    return { ok: true };
  }

  async function run({ point, placeLabel, periodA, periodB }) {
    silence();
    patch({ status: 'loading', error: null, result: null, playing: null, lastPlay: null, ended: false, playError: null });
    const outcome = await runGuardedAction(coordinator, {
      run: () => loadHistoryResult({ repository, point, periodA, periodB, placeLabel }),
      onSuccess: ({ result }) => {
        patch({ status: 'ready', error: null, result });
        onShowPoint?.(result.point.lat, result.point.lon);
      }
    });
    if (outcome.applied) return { ok: true, result: outcome.result.result };
    if (outcome.reason === 'stale') return { ok: false, reason: 'stale' };
    patch({ status: 'error', error: outcome.reason, result: null });
    return { ok: false, reason: outcome.reason };
  }

  /** Formulario: lugar elegido + mes/ano de nacimiento. Devuelve el error de validacion o la promesa de la consulta. */
  function submit({ place, year, month }) {
    const placeCheck = validatePlace(place);
    if (!placeCheck.ok) return Promise.resolve({ ok: false, reason: 'noPlace', field: 'place' });
    const birth = validateBirth({ year, month }, repository.availablePeriods);
    if (!birth.ok) return Promise.resolve({ ...birth, field: 'birth' });
    return run({
      point: { lat: place.lat, lon: place.lon },
      placeLabel: place.label ?? null,
      periodA: birth.period,
      periodB: latestPeriod()
    });
  }

  /** Enlace compartido: punto y dos periodos. Sin audio. */
  function applyShared({ point, a, b }) {
    const placeCheck = validatePlace(point);
    if (!placeCheck.ok) return Promise.resolve({ ok: false, reason: 'noPlace', field: 'place' });
    if (!repository.hasPeriod(a) || !repository.hasPeriod(b)) {
      return Promise.resolve({ ok: false, reason: 'notAvailable', field: 'birth' });
    }
    return run({ point: { lat: point.lat, lon: point.lon }, placeLabel: null, periodA: a, periodB: b });
  }

  /**
   * Invalida consulta en vuelo, audio y resultado (conserva el borrador del
   * formulario, que vive en el panel). Sin efecto si no hay nada activo: asi
   * un clic en el globo en reposo no corta otras narraciones.
   */
  function cancelQuery() {
    const h = store.get().history;
    if (h.status === 'idle' && !h.playing && !h.playError) return;
    coordinator.startAction();
    silence();
    patch({ status: 'idle', error: null, result: null, playing: null, lastPlay: null, ended: false, playError: null });
  }

  /** "Borrar mi historia": quita resultado y deja el estado inicial. */
  function clear() {
    coordinator.startAction();
    silence();
    store.set((s) => ({ history: { ...createHistoryState(), voice: s.history.voice } }));
  }

  /** Llamar desde el render del store: aplica las reglas de salida de pestana y silencio. */
  let wasOnHistory = true;
  function enforce(state) {
    const h = state.history;
    const onHistory = state.activeTab === 'history';
    if (wasOnHistory && !onHistory) narrator?.cancel();
    wasOnHistory = onHistory;
    if (!onHistory) {
      if (h.status === 'loading') cancelQuery();
      else if (h.playing) stop();
      return;
    }
    if (h.playing && state.audio.muted) stop();
  }

  return { submit, applyShared, play, playAuto, repeat, stop, speakStory, setVoice, cancelQuery, clear, enforce };
}
