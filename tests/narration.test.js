import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createNarrator } from '../src/accessibility/narration.js';

// Mock minimo de SpeechSynthesis/SpeechSynthesisUtterance: no dispara
// eventos solo; el test los dispara a mano para controlar el orden exacto
// (onstart tardio de una utterance ya cancelada, etc).
class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.lang = null;
    this.voice = null;
    this.volume = 1; // valor por defecto real de SpeechSynthesisUtterance
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

function createFakeSynth() {
  const spoken = [];
  return {
    spoken,
    getVoices: () => [],
    addEventListener: () => {},
    speak: vi.fn((utterance) => spoken.push(utterance)),
    cancel: vi.fn()
  };
}

beforeEach(() => {
  globalThis.window = globalThis.window ?? {};
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
});

describe('createNarrator: volumen sigue al volumen maestro y al mute', () => {
  it('con audioEngine muteado, la utterance se habla con volumen 0 (no el volumen por defecto 1)', () => {
    window.speechSynthesis = createFakeSynth();
    const audioEngine = { isMuted: () => true, volumeDb: -12, setDucked: vi.fn() };
    const narrator = createNarrator({ audioEngine });

    narrator.speak('hola', 'es');
    const [utterance] = window.speechSynthesis.spoken;
    expect(utterance.volume).toBe(0);
  });

  it('sin mute, el volumen lineal refleja el volumenDb del motor (no siempre 1)', () => {
    window.speechSynthesis = createFakeSynth();
    const audioEngine = { isMuted: () => false, volumeDb: -12, setDucked: vi.fn() };
    const narrator = createNarrator({ audioEngine });

    narrator.speak('hola', 'es');
    const [utterance] = window.speechSynthesis.spoken;
    // -12 dB -> ganancia lineal ~0.251, nunca 1 (volumen por defecto) ni 0.
    expect(utterance.volume).toBeGreaterThan(0);
    expect(utterance.volume).toBeLessThan(1);
    expect(utterance.volume).toBeCloseTo(10 ** (-12 / 20), 3);
  });

  it('volumen 0 dB (maximo) produce ganancia lineal 1', () => {
    window.speechSynthesis = createFakeSynth();
    const audioEngine = { isMuted: () => false, volumeDb: 0, setDucked: vi.fn() };
    const narrator = createNarrator({ audioEngine });
    narrator.speak('hola', 'es');
    expect(window.speechSynthesis.spoken[0].volume).toBe(1);
  });
});

describe('createNarrator: onstart tardio de una utterance ya cancelada no duckea', () => {
  it('si speak() se llama dos veces seguidas, el onstart de la PRIMERA (vieja) utterance no debe duckear ni notificar', () => {
    window.speechSynthesis = createFakeSynth();
    const setDucked = vi.fn();
    const audioEngine = { isMuted: () => false, volumeDb: -12, setDucked };
    const narrator = createNarrator({ audioEngine });

    narrator.speak('primera', 'es');
    const first = window.speechSynthesis.spoken[0];

    // Antes de que el navegador dispare onstart de la primera, se pide otra
    // narracion: cancel() interno dentro de speak() ya puso current=null y
    // luego lo movio a la segunda utterance (y ya desduckeo una vez al
    // cancelar la primera, que nunca habia llegado a duckear).
    narrator.speak('segunda', 'es');
    const second = window.speechSynthesis.spoken[1];
    setDucked.mockClear();

    // El navegador dispara, tarde, el onstart de la PRIMERA utterance
    // (ya reemplazada): no debe tener ningun efecto.
    first.onstart();
    expect(setDucked).not.toHaveBeenCalled();

    // El onstart de la utterance VIGENTE si debe duckear.
    second.onstart();
    expect(setDucked).toHaveBeenCalledWith(true);
  });

  it('onend de una utterance vieja no restaura el ducking de la vigente', () => {
    window.speechSynthesis = createFakeSynth();
    const setDucked = vi.fn();
    const audioEngine = { isMuted: () => false, volumeDb: -12, setDucked };
    const narrator = createNarrator({ audioEngine });

    narrator.speak('primera', 'es');
    const first = window.speechSynthesis.spoken[0];
    narrator.speak('segunda', 'es');
    const second = window.speechSynthesis.spoken[1];
    second.onstart();
    setDucked.mockClear();

    first.onend(); // tardio: la vigente es "second", no "first"
    expect(setDucked).not.toHaveBeenCalled();

    second.onend();
    expect(setDucked).toHaveBeenCalledWith(false);
  });
});
