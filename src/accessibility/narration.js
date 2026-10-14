// Narracion propia por voz (SpeechSynthesis), OPT-IN: solo habla cuando el
// usuario pulsa "Escuchar historia" explicitamente. Nunca arranca sola, para
// no competir con un lector de pantalla que el usuario ya pueda tener
// activo. Si la API no esta disponible, isSupported() devuelve false y la
// UI debe seguir funcionando solo con el texto (ver ui/peru-panel.js y
// ui/accessible-panel.js: nunca dependen de esto para mostrar informacion).

function pickVoice(synth, lang) {
  const voices = synth.getVoices();
  if (!voices || voices.length === 0) return null;
  if (lang === 'en') {
    return voices.find((v) => v.lang?.toLowerCase().startsWith('en')) ?? null;
  }
  // Preferencia es-PE > es-* > en-* si no hay ninguna voz en espanol
  // (nunca se garantiza que exista una voz peruana instalada).
  return (
    voices.find((v) => v.lang?.toLowerCase() === 'es-pe') ??
    voices.find((v) => v.lang?.toLowerCase().startsWith('es')) ??
    null
  );
}

// Convierte dB (rango de AUDIO_SAFETY, siempre <= 0) a ganancia lineal
// 0..1 para SpeechSynthesisUtterance.volume (que no acepta dB). -Infinity
// (mute real) se mapea a 0 exacto, nunca a un residuo audible.
function dbToLinearVolume(db) {
  if (db === -Infinity || typeof db !== 'number' || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, 10 ** (db / 20)));
}

export function createNarrator({ audioEngine } = {}) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  let current = null;
  const listeners = new Set();

  if (synth && typeof synth.addEventListener === 'function') {
    // Las voces se cargan de forma asincrona en varios navegadores; no se
    // bloquea nada esperandolas, solo se vuelve a intentar elegir voz
    // cuando el evento llega.
    synth.addEventListener('voiceschanged', () => {});
  }

  function isSupported() {
    return Boolean(synth);
  }

  function isSpeaking() {
    return current !== null;
  }

  function notify(state) {
    for (const fn of listeners) fn(state);
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function endCurrent() {
    current = null;
    audioEngine?.setDucked(false);
    notify({ speaking: false });
  }

  /** Cancela cualquier narracion en curso. Restaura el volumen de musica
   * (deja de "duckear") sin tocar el mute del usuario. */
  function cancel() {
    if (!synth) return;
    const wasSpeaking = current !== null;
    synth.cancel();
    if (wasSpeaking) endCurrent();
  }

  /**
   * Habla `text` en `lang` ('es' | 'en'). Cancela cualquier narracion
   * anterior primero (nunca se superponen dos utterances). Reduce la
   * musica mientras habla y la restaura al terminar o si se cancela.
   * Devuelve false si la API no esta disponible (la UI debe mostrar el
   * texto igual, de forma no condicionada a esto).
   */
  function speak(text, lang) {
    if (!synth || !text) return false;
    cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === 'en' ? 'en-US' : 'es-PE';
    const voice = pickVoice(synth, lang);
    if (voice) utterance.voice = voice;
    // La voz sigue el volumen maestro y el mute (ganancia lineal 0..1
    // derivada de audioEngine.volumeDb); muteado => volumen 0 explicito,
    // nunca el volumen por defecto de SpeechSynthesis (1).
    utterance.volume = audioEngine?.isMuted() ? 0 : dbToLinearVolume(audioEngine?.volumeDb);

    utterance.onstart = () => {
      // Un onstart tardio de una utterance ya cancelada (reemplazada por
      // otra llamada a speak()/cancel() antes de que el navegador dispare
      // este evento) NUNCA debe duckear la musica ni notificar "hablando":
      // solo la utterance VIGENTE (current === esta misma) puede hacerlo.
      if (current !== utterance) return;
      audioEngine?.setDucked(true);
      notify({ speaking: true, lang });
    };
    utterance.onend = () => {
      if (current === utterance) endCurrent();
    };
    utterance.onerror = () => {
      if (current === utterance) endCurrent();
    };

    current = utterance;
    synth.speak(utterance);
    return true;
  }

  return { isSupported, isSpeaking, speak, cancel, onChange };
}
