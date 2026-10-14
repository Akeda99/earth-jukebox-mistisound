import { t, availableLangs } from '../i18n/index.js';
import { legendStops } from '../globe/numeric-overlay.js';

function fmtValue(value, lang) {
  if (value === null || value === undefined) return t(lang, 'noData');
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function fmtCoords(point) {
  if (!point) return '';
  const latDir = point.lat >= 0 ? 'N' : 'S';
  const lonDir = point.lon >= 0 ? 'E' : 'W';
  return `${Math.abs(point.lat).toFixed(2)}°${latDir}, ${Math.abs(point.lon).toFixed(2)}°${lonDir}`;
}

function drawLegend(canvas) {
  const ctx = canvas.getContext('2d');
  const stops = legendStops();
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  stops.forEach((stop, i) => {
    const [r, g, b] = stop.color;
    gradient.addColorStop(i / (stops.length - 1), `rgb(${r},${g},${b})`);
  });
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/**
 * Conecta los controles de audio, el panel de informacion del punto, la
 * comparacion A/B y la leyenda al store. Devuelve render() para refrescar
 * textos tras un cambio de idioma.
 */
export function createControls({ store, audioEngine, narrator, onListen, onCompareA, onCompareB, onListenCompare }) {
  const els = {
    audioToggle: document.getElementById('audio-toggle'),
    muteToggle: document.getElementById('mute-toggle'),
    volumeSlider: document.getElementById('volume-slider'),
    volumeValue: document.getElementById('volume-value'),
    pointEmpty: document.getElementById('point-empty'),
    pointDetails: document.getElementById('point-details'),
    coords: document.getElementById('field-coords'),
    cell: document.getElementById('field-cell'),
    period: document.getElementById('field-period'),
    value: document.getElementById('field-value'),
    units: document.getElementById('field-units'),
    baseline: document.getElementById('field-baseline'),
    resolution: document.getElementById('field-resolution'),
    smoothing: document.getElementById('field-smoothing'),
    listenBtn: document.getElementById('listen-btn'),
    compareA: document.getElementById('compare-a-btn'),
    compareB: document.getElementById('compare-b-btn'),
    compareListenA: document.getElementById('compare-listen-a-btn'),
    compareListenB: document.getElementById('compare-listen-b-btn'),
    compareResult: document.getElementById('compare-result'),
    legendCanvas: document.getElementById('legend-canvas')
  };

  drawLegend(els.legendCanvas);

  els.audioToggle.addEventListener('click', async () => {
    await audioEngine.start();
    store.set((s) => ({ audio: { ...s.audio, started: true } }));
  });

  els.muteToggle.addEventListener('click', () => {
    const muted = !store.get().audio.muted;
    audioEngine.setMuted(muted);
    // El silencio global tambien cancela cualquier narracion en curso
    // (ver src/accessibility/narration.js): mutear debe cortar TODO el
    // audio, no solo la musica/sonificacion.
    narrator?.cancel();
    store.set((s) => ({ audio: { ...s.audio, muted } }));
  });

  els.volumeSlider.addEventListener('input', (e) => {
    const db = Number(e.target.value);
    audioEngine.setVolumeDb(db);
    store.set((s) => ({ audio: { ...s.audio, volumeDb: db } }));
  });

  els.listenBtn.addEventListener('click', () => onListen?.());
  els.compareA.addEventListener('click', () => onCompareA?.());
  els.compareB.addEventListener('click', () => onCompareB?.());
  els.compareListenA?.addEventListener('click', () => onListenCompare?.('a'));
  els.compareListenB?.addEventListener('click', () => onListenCompare?.('b'));

  function render(state) {
    const { lang, selectedPoint, cell, dataset, audio, compare } = state;

    els.audioToggle.textContent = t(lang, audio.started ? 'audioActive' : 'audioActivate');
    els.audioToggle.disabled = audio.started;
    // Silencio/volumen SIEMPRE visibles y operables, incluso antes de
    // activar sonido (ver index.html: ya no dependen de audio.started).
    els.muteToggle.setAttribute('aria-pressed', String(audio.muted));
    els.muteToggle.setAttribute('aria-label', t(lang, 'muteToggleLabel'));
    els.volumeSlider.setAttribute('aria-label', t(lang, 'volumeLabel'));
    if (els.volumeValue) els.volumeValue.textContent = `${audio.volumeDb} dB`;

    const hasCell = Boolean(selectedPoint && cell && dataset);
    els.pointEmpty.hidden = hasCell;
    els.pointDetails.hidden = !hasCell;
    els.listenBtn.disabled = !hasCell || cell?.value === null;
    els.compareA.disabled = !hasCell;
    els.compareB.disabled = !hasCell || !compare.a;

    if (hasCell) {
      els.coords.textContent = fmtCoords(selectedPoint);
      els.cell.textContent = `${cell.latCenter.toFixed(1)}°, ${cell.lonCenter.toFixed(1)}°`;
      els.period.textContent = dataset.period;
      els.value.textContent = fmtValue(cell.value, lang);
      els.units.textContent = dataset.units;
      els.baseline.textContent = dataset.baseline_period;
      els.resolution.textContent = `${dataset.grid_resolution_deg}°`;
      els.smoothing.textContent = `${dataset.smoothing_radius_km} km`;
    }

    els.compareListenA && (els.compareListenA.disabled = !compare.a || compare.a.value === null);
    els.compareListenB && (els.compareListenB.disabled = !compare.b || compare.b.value === null);

    if (compare.a && compare.b) {
      const diff = compare.b.value !== null && compare.a.value !== null
        ? (compare.b.value - compare.a.value).toFixed(2)
        : t(lang, 'noData');
      els.compareResult.hidden = false;
      els.compareResult.textContent = t(lang, 'compareResult', {
        periodA: compare.a.period,
        valueA: fmtValue(compare.a.value, lang),
        periodB: compare.b.period,
        valueB: fmtValue(compare.b.value, lang),
        diff
      });
    } else {
      els.compareResult.hidden = true;
    }
  }

  return { render };
}

export function createLangSwitch({ store, onChange }) {
  const buttons = Array.from(document.querySelectorAll('.lang-btn'));
  for (const btn of buttons) {
    btn.addEventListener('click', () => onChange(btn.dataset.lang));
  }

  function render(state) {
    for (const btn of buttons) {
      btn.setAttribute('aria-pressed', String(btn.dataset.lang === state.lang));
    }
  }

  return { render, availableLangs: availableLangs() };
}
