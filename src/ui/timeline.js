import { t } from '../i18n/index.js';

const PLAY_INTERVAL_MS = 1200;

function groupByYear(periods) {
  const byYear = new Map();
  for (const period of periods) {
    const [year, month] = period.split('-');
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(month);
  }
  return byYear;
}

/**
 * Barra de tiempo: selector de ano/mes + reproducir/pausar + control
 * nativo de rango (ano) sobre los periodos realmente disponibles en el
 * manifiesto.
 *
 * Cambiar de periodo a mano (selects) SI sonifica el punto seleccionado (si
 * hay audio activo/no muteado); el avance automatico del reproductor
 * (play/pause) NUNCA sonifica por si solo ("no autoplay audio"): solo
 * actualiza dataset/overlay/UI, para no sorprender al usuario con una
 * cascada de notas que el no pidio.
 */
export function createTimeline({ store, availablePeriods, onPeriodChange, onTogglePlay }) {
  const yearSelect = document.getElementById('year-select');
  const monthSelect = document.getElementById('month-select');
  const yearRange = document.getElementById('year-range');
  const playBtn = document.getElementById('play-pause-btn');
  const statusEl = document.getElementById('period-status');
  const retryBtn = document.getElementById('period-retry-btn');

  const byYear = groupByYear(availablePeriods);
  const years = Array.from(byYear.keys()).sort();

  for (const year of years) {
    const opt = document.createElement('option');
    opt.value = year;
    opt.textContent = year;
    yearSelect.appendChild(opt);
  }

  if (yearRange && years.length > 0) {
    yearRange.min = '0';
    yearRange.max = String(years.length - 1);
    yearRange.step = '1';
    yearRange.value = '0';
  }

  function populateMonths(year, preferredMonth) {
    monthSelect.innerHTML = '';
    const months = (byYear.get(year) ?? []).sort();
    for (const month of months) {
      const opt = document.createElement('option');
      opt.value = month;
      opt.textContent = month;
      monthSelect.appendChild(opt);
    }
    // Mantiene el mes seleccionado si existe en el nuevo ano; si no, usa el
    // primero disponible en vez de perder siempre la seleccion de mes.
    if (preferredMonth && months.includes(preferredMonth)) {
      monthSelect.value = preferredMonth;
    }
  }

  function currentSelection() {
    return `${yearSelect.value}-${monthSelect.value}`;
  }

  if (years.length > 0) populateMonths(years[0]);

  yearSelect.addEventListener('change', () => {
    const previousMonth = monthSelect.value;
    populateMonths(yearSelect.value, previousMonth);
    if (yearRange) yearRange.value = String(years.indexOf(yearSelect.value));
    onPeriodChange(currentSelection(), { sonify: true });
  });
  monthSelect.addEventListener('change', () => onPeriodChange(currentSelection(), { sonify: true }));
  playBtn.addEventListener('click', () => onTogglePlay());
  retryBtn?.addEventListener('click', () => onPeriodChange(currentSelection(), { sonify: false }));

  if (yearRange) {
    yearRange.addEventListener('input', () => {
      const year = years[Number(yearRange.value)];
      if (!year) return;
      const previousMonth = monthSelect.value;
      if (yearSelect.value !== year) {
        yearSelect.value = year;
        populateMonths(year, previousMonth);
      }
      onPeriodChange(currentSelection(), { sonify: true });
    });
  }

  let timerHandle = null;
  let stopped = true;

  // Avance recursivo con setTimeout (en vez de setInterval) para no acumular
  // ticks si una carga de periodo tarda mas que PLAY_INTERVAL_MS: el
  // siguiente tick solo se programa despues de que el anterior termino.
  async function scheduleNextTick() {
    if (stopped) return;
    timerHandle = setTimeout(async () => {
      if (stopped) return;
      const idx = availablePeriods.indexOf(currentSelection());
      const nextIdx = (idx + 1) % availablePeriods.length;
      const next = availablePeriods[nextIdx];
      const [year, month] = next.split('-');
      if (yearSelect.value !== year) {
        yearSelect.value = year;
        populateMonths(year, month);
        if (yearRange) yearRange.value = String(years.indexOf(year));
      }
      monthSelect.value = month;
      // sonify:true: si el usuario YA activo el audio y pulso Reproducir
      // (accion explicita, no autoplay), cada periodo confirmado del
      // avance historico actualiza la musica del punto seleccionado.
      // maybeSonifySelectedCell (ver main.js) solo suena si audio.started
      // es verdadero, asi que esto nunca activa sonido por si solo al
      // abrir la app ni durante una carga inicial/preset (que siguen
      // usando sonify:false explicitamente).
      await onPeriodChange(next, { sonify: true });
      scheduleNextTick();
    }, PLAY_INTERVAL_MS);
  }

  function startPlayback() {
    if (!stopped) return; // ya corriendo: no reiniciar el temporizador
    stopped = false;
    scheduleNextTick();
  }

  function stopPlayback() {
    stopped = true;
    if (timerHandle) clearTimeout(timerHandle);
    timerHandle = null;
  }

  let wasPlaying = false;
  let lastSyncedPeriod = null;

  function render(state) {
    const { lang, playback, requestedPeriod, confirmedPeriod, periodError, overlayError } = state;
    playBtn.textContent = t(lang, playback.playing ? 'pauseBtn' : 'playBtn');
    playBtn.setAttribute('aria-pressed', String(playback.playing));

    // Solo (re)programar el temporizador en la transicion false->true, y
    // detenerlo solo en true->false: evita reiniciar el intervalo en cada
    // render (p.ej. cada vez que cambia el dataset mientras se reproduce).
    if (playback.playing && !wasPlaying) startPlayback();
    else if (!playback.playing && wasPlaying) stopPlayback();
    wasPlaying = playback.playing;

    // Sincroniza ano/mes/control deslizante con el periodo CONFIRMADO ante
    // CUALQUIER cambio externo (consulta Accesible, visita Peru, preset por
    // enlace, DJ), no solo cuando el usuario mueve estos mismos controles:
    // sin esto, los selects globales quedaban en el periodo anterior
    // mientras period-status ya mostraba el nuevo.
    if (confirmedPeriod && confirmedPeriod !== lastSyncedPeriod) {
      setPeriodSelects(confirmedPeriod);
      lastSyncedPeriod = confirmedPeriod;
    }

    if (periodError) {
      statusEl.textContent = t(lang, 'periodError', { period: periodError });
      if (retryBtn) retryBtn.hidden = false;
    } else if (retryBtn) {
      retryBtn.hidden = true;
    }

    if (!periodError) {
      if (requestedPeriod && requestedPeriod !== confirmedPeriod) {
        statusEl.textContent = t(lang, 'periodRequested', { period: requestedPeriod });
      } else if (confirmedPeriod) {
        statusEl.textContent = t(lang, 'periodConfirmed', { period: confirmedPeriod });
      } else {
        statusEl.textContent = '';
      }
      // El dataset confirmado sigue siendo valido aunque el overlay visual
      // haya fallado; se avisa explicitamente en vez de dejar la imagen
      // anterior con la etiqueta del periodo nuevo (ver main.js:changePeriod).
      if (overlayError && overlayError === confirmedPeriod) {
        statusEl.textContent += ` ${t(lang, 'overlayError', { period: overlayError })}`;
      }
    }
  }

  function setPeriodSelects(period) {
    const [year, month] = period.split('-');
    if (yearSelect.value !== year) {
      yearSelect.value = year;
      populateMonths(year, month);
    }
    monthSelect.value = month;
    if (yearRange) yearRange.value = String(years.indexOf(year));
  }

  return { render, setPeriodSelects, stopPlayback };
}
