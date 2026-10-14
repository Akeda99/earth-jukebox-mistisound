// Panel "Recursos EIC": seccion accesible desplegable (NASA SVS, mapa
// anual GISTEMP 2025 verificado + indicador GLOBAL ANUAL del mismo anio/
// dataset/baseline, ver docs/eic-integration.md y public/data/eic-annual.json).
// Independiente del modo mensual/rejilla local: nunca sobreescribe la celda
// ni el mes actual del resto de la app. Solo ofrece anios con frame Y dato
// verificados juntos (hoy: unicamente 2025); no deriva fechas del
// video/espiral (ver docs, seccion de limites).
import { t } from '../i18n/index.js';

export function createEicPanel({ store, audioEngine }) {
  const root = document.getElementById('eic-panel');
  if (!root) return { render: () => {} };

  root.innerHTML = '';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.setAttribute('data-i18n', 'eicTitle');
  const intro = document.createElement('p');
  intro.setAttribute('data-i18n', 'eicIntro');

  const yearRow = document.createElement('div');
  yearRow.className = 'form-row';
  const yearLabel = document.createElement('label');
  yearLabel.setAttribute('data-i18n', 'eicYearLabel');
  yearLabel.htmlFor = 'eic-year-select';
  const yearSelect = document.createElement('select');
  yearSelect.id = 'eic-year-select';
  yearRow.append(yearLabel, yearSelect);

  const img = document.createElement('img');
  img.id = 'eic-frame-img';
  img.loading = 'lazy';
  img.alt = '';
  img.width = 480;
  img.height = 270;
  const imgError = document.createElement('p');
  imgError.id = 'eic-img-error';
  imgError.hidden = true;
  imgError.setAttribute('data-i18n', 'eicImageError');

  const valueEl = document.createElement('p');
  valueEl.id = 'eic-value';
  const baselineEl = document.createElement('p');
  baselineEl.id = 'eic-baseline';
  const creditEl = document.createElement('p');
  creditEl.id = 'eic-credit';
  const revisionEl = document.createElement('p');
  revisionEl.id = 'eic-revision';
  const sourceLink = document.createElement('a');
  sourceLink.id = 'eic-source-link';
  sourceLink.target = '_blank';
  sourceLink.rel = 'noopener';
  sourceLink.setAttribute('data-i18n', 'eicSourceLink');

  const listenBtn = document.createElement('button');
  listenBtn.type = 'button';
  listenBtn.className = 'action-btn';
  listenBtn.id = 'eic-listen-btn';
  listenBtn.setAttribute('data-i18n', 'eicListenBtn');

  details.append(
    summary,
    intro,
    yearRow,
    img,
    imgError,
    valueEl,
    baselineEl,
    creditEl,
    revisionEl,
    sourceLink,
    listenBtn
  );
  root.appendChild(details);

  let entries = [];
  let selectedYear = null;
  let loadGeneration = 0;

  img.addEventListener('error', () => {
    imgError.hidden = false;
  });
  img.addEventListener('load', () => {
    imgError.hidden = true;
  });

  function entryFor(year) {
    return entries.find((e) => e.year === year) ?? null;
  }

  /**
   * Cambiar de anio: el dato TEXTUAL (valor/linea base/credito/fuente) se
   * muestra YA MISMO, independiente de la red (nunca espera a que la
   * imagen remota termine de cargar, para no dejar el selector sin valores
   * si la imagen tarda o falla). La imagen se precarga por separado (con un
   * generador de versiones para descartar una preparacion vieja si el
   * usuario cambia de anio otra vez antes de que la primera termine).
   */
  function selectYear(year) {
    const myGeneration = ++loadGeneration;
    const entry = entryFor(year);
    if (!entry) return;
    applyEntry(entry);
    const preload = new Image();
    preload.onload = () => {
      if (myGeneration !== loadGeneration) return; // un cambio de anio mas reciente ya lo reemplazo
      imgError.hidden = true;
      img.src = entry.frame_url;
    };
    preload.onerror = () => {
      if (myGeneration !== loadGeneration) return;
      imgError.hidden = false;
    };
    preload.src = entry.frame_url;
  }

  function applyEntry(entry) {
    selectedYear = entry.year;
    const lang = store.get().lang;
    // alt localizado ES/EN describiendo la imagen (no el titulo en ingles
    // de la pagina fuente, que se mantiene intacto en el enlace/credito):
    // un lector de pantalla en espanol no deberia anunciar un alt en ingles.
    img.alt = t(lang, 'eicImageAlt', { year: entry.year });
    valueEl.textContent = t(lang, 'eicValue', { year: entry.year, value: `+${entry.value.toFixed(2)}`, units: entry.units });
    baselineEl.textContent = t(lang, 'eicBaseline', { baseline: entry.baseline_period });
    creditEl.textContent = t(lang, 'eicCredit', { credit: entry.credit, date: entry.frame_publication_date });
    revisionEl.textContent = t(lang, 'eicRevisionWarning');
    sourceLink.href = entry.frame_page;
    // "Escuchar" nunca se habilita solo porque hay un dato: requiere el
    // motor de audio ya activado (gesto previo "Activar sonido").
    listenBtn.disabled = !audioEngine.isStarted();
  }

  listenBtn.addEventListener('click', () => {
    const entry = entryFor(selectedYear);
    // Sonifica el indicador GLOBAL AGREGADO del mismo anio/dataset/baseline
    // (NUNCA lectura de pixel ni valor de celda local): mismo motor/bus que
    // el resto de la app (mute/volumen/limiter ya aplicados por AudioEngine).
    if (entry && audioEngine.isStarted()) audioEngine.playAnomaly(entry.value);
  });

  yearSelect.addEventListener('change', () => {
    selectYear(Number(yearSelect.value));
  });

  async function loadIndex() {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/eic-annual.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      entries = Array.isArray(json.entries) ? json.entries : [];
      yearSelect.innerHTML = '';
      for (const entry of entries) {
        const opt = document.createElement('option');
        opt.value = String(entry.year);
        opt.textContent = String(entry.year);
        yearSelect.appendChild(opt);
      }
      if (entries.length > 0) yearSelect.value = String(entries[0].year);
      // La imagen/dato del primer anio se prepara al ABRIR el <details>, no
      // aqui: si el usuario nunca lo abre, nunca se descarga la imagen
      // remota (ver listener de 'toggle' abajo). No autoplay en ningun caso.
      if (details.open) selectYear(entries[0]?.year);
    } catch (err) {
      console.error('No se pudo cargar eic-annual.json', err);
      entries = [];
    }
  }

  details.addEventListener('toggle', () => {
    if (details.open && selectedYear === null && entries.length > 0) {
      selectYear(Number(yearSelect.value) || entries[0].year);
    }
  });

  function render(state) {
    const { lang } = state;
    listenBtn.disabled = !entryFor(selectedYear) || !audioEngine.isStarted();
    // Re-render de textos traducidos sin volver a precargar la imagen.
    const entry = entryFor(selectedYear);
    if (entry) {
      img.alt = t(lang, 'eicImageAlt', { year: entry.year });
      valueEl.textContent = t(lang, 'eicValue', { year: entry.year, value: `+${entry.value.toFixed(2)}`, units: entry.units });
      baselineEl.textContent = t(lang, 'eicBaseline', { baseline: entry.baseline_period });
      creditEl.textContent = t(lang, 'eicCredit', { credit: entry.credit, date: entry.frame_publication_date });
      revisionEl.textContent = t(lang, 'eicRevisionWarning');
    }
  }

  loadIndex();

  return { render };
}
