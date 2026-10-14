// Pestana "Tu historia": formulario (lugar + mes/ano de nacimiento) y
// resultado. Capa fina de DOM sobre history-controller.js: solo lee el
// store, pinta con textContent (nunca innerHTML con datos) y delega.
import { t } from '../i18n/index.js';
import {
  searchCities,
  cityRowToPlace,
  formatPlaceLabel,
  formatCoords,
  formatMonthYear,
  formatDegrees,
  buildStory,
  epochAnnouncement,
  MIN_QUERY_LENGTH
} from '../history/history-core.js';

export function createHistoryPanel({ store, controller, repository, loadCities, getGlobePoint, narrator }) {
  const $ = (id) => document.getElementById(id);
  const form = $('history-form');
  const queryInput = $('history-place-q');
  const searchBtn = $('history-place-search');
  const placeStatus = $('history-place-status');
  const placeResults = $('history-place-results');
  const useGlobeBtn = $('history-use-globe');
  const placeChosen = $('history-place-chosen');
  const monthSelect = $('history-month');
  const yearInput = $('history-year');
  const birthNote = $('history-birth-note');
  const formError = $('history-form-error');
  const latestNote = $('history-latest-note');
  const loadStatus = $('history-load-status');
  const resultSection = $('history-result');
  const resultTitle = $('history-result-title');
  const storyEl = $('history-story');
  const dataEl = $('history-data');
  const summaryEl = $('history-summary');
  const cardAPeriod = $('history-card-a-period');
  const cardAValue = $('history-card-a-value');
  const cardBPeriod = $('history-card-b-period');
  const cardBValue = $('history-card-b-value');
  const cardDelta = $('history-card-delta');
  const listenA = $('history-listen-a');
  const listenB = $('history-listen-b');
  const listenAuto = $('history-listen-auto');
  const repeatBtn = $('history-repeat');
  const stopBtn = $('history-stop');
  const voiceBox = $('history-voice');
  const speakBtn = $('history-speak');
  const playStatus = $('history-play-status');
  const audioHint = $('history-audio-hint');
  const missingEl = $('history-missing');
  const clearBtn = $('history-clear');

  let place = null;
  let formErrorKey = null;
  let searchToken = 0;
  let lastSearch = null;
  let monthsLang = null;
  const sigs = new Map();

  const periods = repository.availablePeriods;
  const firstPeriod = periods[0] ?? null;
  const lastPeriod = periods[periods.length - 1] ?? null;

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function lang() {
    return store.get().lang;
  }

  function showFormError(key, params = {}) {
    formErrorKey = key ? { key, params } : null;
    renderFormError();
  }

  function renderFormError() {
    const text = formErrorKey ? t(lang(), formErrorKey.key, formErrorKey.params) : '';
    setText(formError, text);
    const invalid = Boolean(formErrorKey);
    yearInput.setAttribute('aria-invalid', String(invalid && formErrorKey.key !== 'historyErrNoPlace'));
  }

  function setPlace(next) {
    controller.cancelQuery();
    place = next;
    renderPlace();
  }

  function renderPlace() {
    if (!place) {
      setText(placeChosen, t(lang(), 'historyPlaceNone'));
      return;
    }
    const label = place.name ? formatPlaceLabel(place, lang()) : formatCoords(place.lat, place.lon);
    setText(placeChosen, t(lang(), 'historyPlaceChosen', { label, coords: formatCoords(place.lat, place.lon) }));
  }

  function renderSearchResults() {
    const l = lang();
    placeResults.replaceChildren();
    if (!lastSearch) return;
    if (lastSearch.state === 'loading') {
      setText(placeStatus, t(l, 'historyCatalogLoading'));
      return;
    }
    if (lastSearch.state === 'error') {
      setText(placeStatus, t(l, 'historyCatalogError'));
      return;
    }
    if (lastSearch.state === 'short') {
      setText(placeStatus, t(l, 'historySearchShort'));
      return;
    }
    const { items, total, q } = lastSearch;
    if (total === 0) {
      setText(placeStatus, t(l, 'historySearchNone', { q }));
      return;
    }
    setText(
      placeStatus,
      total === 1
        ? t(l, 'historySearchOne')
        : total > items.length
        ? t(l, 'historySearchCount', { total, shown: items.length })
        : t(l, 'historySearchCountAll', { total })
    );
    for (const row of items) {
      const candidate = cityRowToPlace(row);
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary-btn';
      btn.textContent = `${formatPlaceLabel(candidate, l)} · ${formatCoords(candidate.lat, candidate.lon)}`;
      btn.addEventListener('click', () => {
        setPlace({ ...candidate });
        lastSearch = null;
        placeResults.replaceChildren();
        setText(placeStatus, '');
        showFormError(null);
        yearInput.focus();
      });
      li.appendChild(btn);
      placeResults.appendChild(li);
    }
  }

  async function runSearch() {
    searchToken += 1;
    const token = searchToken;
    const q = queryInput.value;
    if (q.trim().length < MIN_QUERY_LENGTH) {
      lastSearch = { state: 'short' };
      renderSearchResults();
      return;
    }
    lastSearch = { state: 'loading' };
    renderSearchResults();
    let catalog;
    try {
      catalog = await loadCities();
    } catch (err) {
      console.error('No se pudo cargar el catalogo de ciudades', err);
      if (token !== searchToken) return;
      lastSearch = { state: 'error' };
      renderSearchResults();
      return;
    }
    if (token !== searchToken) return;
    const { items, total } = searchCities(catalog.rows, q);
    lastSearch = { state: 'done', items, total, q: q.trim() };
    renderSearchResults();
  }

  searchBtn.addEventListener('click', runSearch);
  queryInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      runSearch();
    }
  });

  useGlobeBtn.addEventListener('click', () => {
    const point = getGlobePoint();
    if (!point) {
      showFormError('historyErrNoPlace');
      return;
    }
    setPlace({ lat: point.lat, lon: point.lon });
    showFormError(null);
  });

  for (const el of [yearInput, monthSelect]) {
    el.addEventListener('input', () => {
      controller.cancelQuery();
      showFormError(null);
    });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showFormError(null);
    const label = place ? (place.name ? formatPlaceLabel(place, lang()) : null) : null;
    const outcome = await controller.submit({
      place: place ? { lat: place.lat, lon: place.lon, label } : null,
      year: yearInput.value,
      month: monthSelect.value
    });
    if (outcome.reason === 'stale') return;
    if (outcome.ok) {
      focusResultTitle();
      return;
    }
    const keys = {
      noPlace: ['historyErrNoPlace'],
      empty: ['historyErrEmpty'],
      invalid: ['historyErrInvalid'],
      beforeSource: ['historyErrBefore', { min: formatMonthYear(outcome.min ?? firstPeriod, lang()) }],
      afterLatest: ['historyErrAfter', { max: formatMonthYear(outcome.max ?? lastPeriod, lang()) }],
      notAvailable: ['historyErrNotAvailable'],
      noSource: ['historyErrNoSource']
    };
    if (keys[outcome.reason]) {
      showFormError(...keys[outcome.reason]);
      if (outcome.reason === 'noPlace') queryInput.focus();
      else yearInput.focus();
    }
  });

  function focusResultTitle() {
    if (resultSection.hidden) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    resultTitle.focus({ preventScroll: true });
    resultTitle.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }

  listenA.addEventListener('click', async () => {
    await controller.play('a');
  });
  listenB.addEventListener('click', async () => {
    await controller.play('b');
  });
  listenAuto.addEventListener('click', async () => {
    await controller.playAuto();
  });
  repeatBtn.addEventListener('click', async () => {
    await controller.repeat();
  });
  stopBtn.addEventListener('click', () => controller.stop());
  voiceBox.addEventListener('change', () => controller.setVoice(voiceBox.checked));
  speakBtn.addEventListener('click', () => controller.speakStory());
  clearBtn.addEventListener('click', () => {
    controller.clear();
    place = null;
    lastSearch = null;
    queryInput.value = '';
    yearInput.value = '';
    monthSelect.value = '';
    placeResults.replaceChildren();
    setText(placeStatus, '');
    showFormError(null);
    renderPlace();
    queryInput.focus();
  });

  function renderMonths() {
    const l = lang();
    if (monthsLang === l) return;
    const previous = monthSelect.value;
    monthSelect.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '—';
    monthSelect.appendChild(blank);
    for (let m = 1; m <= 12; m += 1) {
      const opt = document.createElement('option');
      opt.value = String(m);
      const name = formatMonthYear(`2001-${String(m).padStart(2, '0')}`, l).replace(/\s*(de\s)?2001$/, '');
      opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      monthSelect.appendChild(opt);
    }
    monthSelect.value = previous;
    monthsLang = l;
  }

  function renderResult(state) {
    const l = state.lang;
    const h = state.history;
    const result = h.status === 'ready' ? h.result : null;
    resultSection.hidden = !result;
    if (!result) return;

    const { a, b } = result;
    const periodA = formatMonthYear(a.period, l);
    const periodB = formatMonthYear(b.period, l);
    setText(
      resultTitle,
      t(l, 'historyResultTitle', { place: result.placeLabel ?? formatCoords(result.point.lat, result.point.lon) })
    );

    const noDataWord = t(l, 'historyNoData');
    const deg = (v) => (v === null ? noDataWord : `${formatDegrees(v, { signed: true })} °C`);
    setText(
      summaryEl,
      t(l, 'historySummaryLine', {
        periodA,
        periodB,
        a: deg(a.value),
        b: deg(b.value),
        delta: result.delta === null ? t(l, 'historySummaryNoDelta') : deg(result.delta),
        baseline: String(result.baseline ?? '').replace('-', '–')
      })
    );

    // Tarjetas Antes/Despues: solo presentacion visual de los mismos valores
    // del resumen (aria-hidden en index.html: no se anuncian dos veces).
    const baselineText = String(result.baseline ?? '').replace('-', '–');
    setText(cardAPeriod, periodA);
    setText(cardBPeriod, periodB);
    setText(cardAValue, deg(a.value));
    setText(cardBValue, deg(b.value));
    setText(
      cardDelta,
      `${t(l, 'historyCardDelta', { delta: result.delta === null ? t(l, 'historySummaryNoDelta') : deg(result.delta) })} · ${t(l, 'historyCardBaseline', { baseline: baselineText })}`
    );

    const story = buildStory(result, l, { latestPeriod: lastPeriod });
    const storySig = `${l}|${story.join('|')}`;
    if (sigs.get('story') !== storySig) {
      sigs.set('story', storySig);
      storyEl.replaceChildren();
      for (const line of story) {
        const p = document.createElement('p');
        p.textContent = line;
        storyEl.appendChild(p);
      }
    }

    const noData = t(l, 'historyNoData');
    const rows = [
      [
        t(l, 'historyDataPlace'),
        `${result.placeLabel ? `${result.placeLabel} · ` : ''}${formatCoords(result.point.lat, result.point.lon)}`
      ],
      [t(l, 'historyDataCell'), formatCoords(result.cell.latCenter, result.cell.lonCenter)],
      [t(l, 'historyDataA', { period: periodA }), a.value === null ? noData : `${formatDegrees(a.value, { signed: true })} °C`],
      [t(l, 'historyDataB', { period: periodB }), b.value === null ? noData : `${formatDegrees(b.value, { signed: true })} °C`],
      [
        t(l, 'historyDataDelta'),
        result.delta === null ? noData : `${formatDegrees(result.delta, { signed: true })} °C`
      ],
      [
        t(l, 'historyDataSource'),
        t(l, 'historyDataSourceValue', {
          dataset: result.dataset ?? 'GISTEMP',
          baseline: String(result.baseline ?? '').replace('-', '–')
        })
      ]
    ];
    const dataSig = `${l}|${JSON.stringify(rows)}`;
    if (sigs.get('data') !== dataSig) {
      sigs.set('data', dataSig);
      dataEl.replaceChildren();
      for (const [term, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        dataEl.append(dt, dd);
      }
    }

    setText(listenA, t(l, 'historyListenA', { period: periodA }));
    setText(listenB, t(l, 'historyListenB', { period: periodB }));
    setText(listenAuto, t(l, 'historyListenAuto'));
    setText(repeatBtn, t(l, 'historyRepeat'));
    setText(stopBtn, t(l, 'historyStop'));

    const soundOk = state.audio.started && !state.audio.muted;
    listenA.disabled = !soundOk || a.value === null;
    listenB.disabled = !soundOk || b.value === null;
    listenAuto.disabled = !soundOk || a.value === null || b.value === null;
    repeatBtn.disabled = !soundOk || !h.lastPlay;
    const speechOk = Boolean(narrator?.isSupported?.());
    speakBtn.disabled = !speechOk || state.audio.muted;
    voiceBox.checked = h.voice;

    let hint = '';
    if (!state.audio.started) hint = t(l, 'historyAudioOff');
    else if (state.audio.muted) hint = t(l, 'historyMuted');
    else if (a.value === null || b.value === null) hint = t(l, 'historyNoDataListen');
    else if (!speechOk) hint = t(l, 'historySpeechUnsupported');
    setText(audioHint, hint);

    let status = '';
    if (h.playError) status = t(l, h.playError === 'epoch' ? 'historyEpochError' : 'historyStartError');
    else if (h.playing?.phase === 'loading') status = t(l, 'historyPlayingLoading');
    else if (h.playing?.phase === 'gap') status = t(l, 'historyPlayingGap');
    else if (h.playing) status = t(l, 'historyPlayingNow', { announce: epochAnnouncement(result, h.playing.epoch, l) });
    else if (h.ended) status = t(l, 'historyEnded');
    setText(playStatus, status);

    setText(missingEl, t(l, 'historyMissing'));
  }

  function render(state) {
    const l = state.lang;
    renderMonths();
    if (firstPeriod) setText(birthNote, t(l, 'historyBirthNote', { min: formatMonthYear(firstPeriod, l) }));
    if (lastPeriod) setText(latestNote, t(l, 'historyLatestNote', { period: formatMonthYear(lastPeriod, l) }));
    renderPlace();
    renderFormError();
    if (lastSearch && lastSearch.state !== 'done') renderSearchResults();

    const h = state.history;
    let loadMessage = '';
    if (h.status === 'loading') loadMessage = t(l, 'historyLoading');
    else if (h.status === 'error') {
      loadMessage = t(
        l,
        h.error === 'gridMismatch' ? 'historyGridMismatch' : h.error === 'sourceMismatch' ? 'historySourceMismatch' : 'historyLoadError'
      );
    }
    setText(loadStatus, loadMessage);
    renderResult(state);
  }

  /** Enlace compartido: rellena el formulario con los dos periodos y consulta (sin audio). */
  async function showShared({ point, a, b }) {
    setPlace({ lat: point.lat, lon: point.lon });
    yearInput.value = a.slice(0, 4);
    monthSelect.value = String(Number(a.slice(5, 7)));
    showFormError(null);
    const outcome = await controller.applyShared({ point, a, b });
    if (!outcome.ok && outcome.reason === 'notAvailable') showFormError('historySharedBadPeriod');
    return outcome;
  }

  return { render, showShared, setPlace };
}
