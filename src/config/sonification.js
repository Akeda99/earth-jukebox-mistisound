// Configuracion fija de la sonificacion: escala pentatonica mayor de Do
// (C, D, E, G, A) en octavas 3 a 6, y el rango fijo de anomalia que se
// mapea sobre esa escala.

export const PENTATONIC_DEGREES = ['C', 'D', 'E', 'G', 'A'];
export const OCTAVE_MIN = 3;
export const OCTAVE_MAX = 6;

// Notas ordenadas de grave a aguda, C3 .. A6 (20 notas).
export const PENTATONIC_SCALE = (() => {
  const notes = [];
  for (let octave = OCTAVE_MIN; octave <= OCTAVE_MAX; octave += 1) {
    for (const degree of PENTATONIC_DEGREES) {
      notes.push(`${degree}${octave}`);
    }
  }
  return notes;
})();

// Rango fijo de anomalia del COLOR del globo y de la leyenda visual (en la
// unidad del dataset, K o grados C: misma magnitud, ver docs/data-sources.md).
// NO es el rango musical: ver MUSIC_ANOMALY_RANGE.
export const ANOMALY_RANGE = { min: -5, max: 5 };

// Version del mapeo/estilo musical. v1 (previa): lineal -5..5 sobre 20 notas,
// saturaba todo valor >= 5 en la misma nota. v2: rango extendido -12..12 con
// compresion asinh, ver audio/mapping.js y docs/sonification-rules.md.
export const MUSIC_VERSION = 2;
export const MUSIC_STYLE = 'piano-drops-ice';
export const MUSIC_MOTIF = 'CDEGA';
export const MUSIC_ANOMALY_RANGE = { min: -12, max: 12 };
export const MUSIC_ASINH_SCALE = 2; // u = asinh(a / 2) / asinh(12 / 2)

export const AUDIO_SAFETY = {
  masterGainDb: -12,
  limiterThresholdDb: -3,
  attackSeconds: 0.02,
  releaseSeconds: 0.35,
  noteDurationSeconds: 0.8,
  // Rango documentado de volumen (coincide con el slider #volume-slider en
  // index.html, min=-40 max=0). setVolumeDb satura cualquier valor finito a
  // este rango y rechaza valores no finitos en vez de aceptarlos.
  volumeDbMin: -40,
  volumeDbMax: 0
};
