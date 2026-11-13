import { t } from '../i18n/index.js';
import { formatCoords } from '../history/history-core.js';

/** Presentation only. Never changes a data value, period, preset or audio transport. */
export function createAuroraExperience({ store, audioEngine, onOverlayVisibility, onViewChange }) {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const effectsButton = $('effects-toggle');
  const cursor = $('cosmic-cursor');
  const trail = $('cursor-trail');
  const trailContext = trail.getContext('2d');
  const waveCanvas = $('orbit-waves');
  const waveContext = waveCanvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const listeners = new AbortController();
  const listen = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: listeners.signal });
  const viewModes = { history: false, explore: true, peru: false, accessible: true, dj: false };
  const headings = {
    history: ['historyTitle', 'auroraIntro'], explore: ['auroraExploreTitle', 'auroraExploreIntro'],
    peru: ['auroraPeruTitle', 'auroraPeruIntro'], accessible: ['auroraAccessibleTitle', 'auroraAccessibleIntro'],
    dj: ['auroraDjTitle', 'auroraDjIntro']
  };
  let effectsWanted = true;
  try { effectsWanted = localStorage.getItem('earth-jukebox-effects') !== 'off'; } catch { /* Local preference is optional. */ }
  let enabled = false;
  let inView = true;
  let waveFrame = 0;
  let trailFrame = 0;
  let lastWaveTime = 0;
  let lastPointTime = 0;
  let waveWidth = 0;
  let waveHeight = 0;
  let points = [];
  let analyser = null;
  let previousTab = null;
  let previousLang = null;
  let previousOverlay = null;

  // Deterministic decorative star positions, not scientific measurements.
  for (let i = 0; i < 42; i += 1) {
    const star = document.createElement('i');
    star.className = 'sky-star';
    star.style.left = `${(i * 37.79 + 3) % 100}%`;
    star.style.top = `${(i * 19.13 + 7) % 88}%`;
    star.style.setProperty('--duration', `${3 + i % 6}s`);
    star.style.setProperty('--delay', `${-i * .63}s`);
    $('star-field').append(star);
  }

  function resizeTrail() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    trail.width = Math.round(innerWidth * dpr);
    trail.height = Math.round(innerHeight * dpr);
    trailContext?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function resizeWave() {
    const rect = waveCanvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    waveWidth = rect.width;
    waveHeight = rect.height;
    waveCanvas.width = Math.round(waveWidth * dpr);
    waveCanvas.height = Math.round(waveHeight * dpr);
    waveContext?.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWave(0);
  }

  function drawWave(time) {
    if (!waveContext || !waveWidth) return;
    const ctx = waveContext;
    ctx.clearRect(0, 0, waveWidth, waveHeight);
    let level = 0;
    if (analyser && !store.get().audio.muted) {
      const samples = analyser.getValue();
      let energy = 0;
      for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
      level = Math.min(1, Math.sqrt(energy / samples.length) * 8);
    }
    const phase = enabled ? time * .00022 : 0;
    const gradient = ctx.createLinearGradient(0, 0, waveWidth, 0);
    gradient.addColorStop(0, '#b5f1cb00'); gradient.addColorStop(.18, '#a4eccb80');
    gradient.addColorStop(.5, '#c9dcd43a'); gradient.addColorStop(.82, '#cbb4f58c'); gradient.addColorStop(1, '#cbb4f500');
    ctx.strokeStyle = gradient;
    for (let layer = 0; layer < 7; layer += 1) {
      ctx.lineWidth = layer === 3 ? 1.3 : .65;
      ctx.globalAlpha = .55 + level * .4;
      ctx.beginPath();
      for (let x = 0; x <= waveWidth; x += 5) {
        const u = x / waveWidth;
        const amplitude = (16 + level * 38) * Math.sin(u * Math.PI);
        const y = waveHeight * .58 + Math.sin(u * Math.PI * 3.3 + phase + layer * .18) * amplitude + (layer - 3) * 8;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function animateWave(now) {
    waveFrame = 0;
    if (!enabled || document.hidden || !inView) return;
    if (now - lastWaveTime > 40) { drawWave(now); lastWaveTime = now; }
    waveFrame = requestAnimationFrame(animateWave);
  }
  function syncWaveLoop() {
    if (enabled && !document.hidden && inView) {
      if (!waveFrame) waveFrame = requestAnimationFrame(animateWave);
    } else {
      cancelAnimationFrame(waveFrame); waveFrame = 0; drawWave(0);
    }
  }
  function hideCursor() {
    cursor.classList.remove('is-visible', 'is-down');
    document.body.classList.remove('cursor-active');
  }
  function paintTrail(now) {
    trailFrame = 0;
    trailContext?.clearRect(0, 0, innerWidth, innerHeight);
    if (!enabled || document.hidden || !finePointer.matches || !trailContext) { points = []; return; }
    points = points.filter((point) => now - point.time < 620);
    for (const point of points) {
      const age = (now - point.time) / 620;
      trailContext.globalAlpha = (1 - age) * .48;
      trailContext.strokeStyle = point.violet ? '#dcc3ff' : '#bdfad8';
      trailContext.lineWidth = .8;
      trailContext.beginPath();
      trailContext.arc(point.x, point.y, 3 + age * 15, 0, Math.PI * 2);
      trailContext.stroke();
      trailContext.fillStyle = point.violet ? '#e6d1ff' : '#dcffe7';
      trailContext.beginPath();
      trailContext.arc(point.x - age * 4, point.y + age * 5, 1.3 * (1 - age), 0, Math.PI * 2);
      trailContext.fill();
    }
    trailContext.globalAlpha = 1;
    if (points.length) trailFrame = requestAnimationFrame(paintTrail);
  }

  function syncEffects() {
    enabled = effectsWanted && !reduceMotion.matches;
    root.dataset.effects = enabled ? 'on' : 'off';
    effectsButton.setAttribute('aria-pressed', String(enabled));
    effectsButton.disabled = reduceMotion.matches;
    const lang = store.get().lang;
    const label = t(lang, reduceMotion.matches ? 'auroraReducedMotion' : enabled ? 'auroraEffects' : 'auroraEffectsOff');
    effectsButton.lastElementChild.textContent = label;
    effectsButton.setAttribute('aria-label', label);
    if (!enabled) {
      hideCursor(); points = []; cancelAnimationFrame(trailFrame); trailFrame = 0;
      trailContext?.clearRect(0, 0, innerWidth, innerHeight); $('click-echoes').replaceChildren();
    }
    syncWaveLoop();
  }
  listen(effectsButton, 'click', () => {
    effectsWanted = !effectsWanted;
    try { localStorage.setItem('earth-jukebox-effects', effectsWanted ? 'on' : 'off'); } catch { /* Optional. */ }
    syncEffects();
  });
  listen(reduceMotion, 'change', syncEffects);
  listen(finePointer, 'change', hideCursor);
  listen(window, 'resize', () => {
    resizeTrail();
    onViewChange?.(store.get().activeTab);
  }, { passive: true });
  listen(document, 'visibilitychange', () => { if (document.hidden) hideCursor(); syncWaveLoop(); });
  listen(window, 'blur', hideCursor);
  listen(document, 'pointerout', (event) => { if (!event.relatedTarget) hideCursor(); });
  listen(document, 'keydown', (event) => { if (event.key === 'Tab') hideCursor(); });
  listen(document, 'pointermove', (event) => {
    if (!enabled || !finePointer.matches || event.pointerType !== 'mouse') return;
    const field = event.target.closest?.('input:not([type="range"]),textarea,select');
    if (field) { hideCursor(); return; }
    document.body.classList.add('cursor-active');
    cursor.classList.add('is-visible');
    cursor.style.transform = `translate3d(${event.clientX}px,${event.clientY}px,0)`;
    const hover = Boolean(event.target.closest?.('button:not(:disabled),a,summary,[role="button"]'));
    cursor.classList.toggle('is-hover', hover);
    const now = performance.now();
    if (now - lastPointTime > 45) {
      points.push({ x: event.clientX, y: event.clientY, time: now, violet: hover });
      if (points.length > 16) points.shift();
      lastPointTime = now;
      if (!trailFrame) trailFrame = requestAnimationFrame(paintTrail);
    }
  }, { passive: true });
  listen(document, 'pointerdown', (event) => {
    if (!enabled || !finePointer.matches || event.pointerType !== 'mouse' || event.button !== 0) return;
    cursor.classList.add('is-down');
    const echo = document.createElement('span');
    echo.className = 'click-echo'; echo.style.left = `${event.clientX}px`; echo.style.top = `${event.clientY}px`;
    const echoes = $('click-echoes');
    if (echoes.children.length >= 8) echoes.firstElementChild.remove();
    echoes.append(echo);
    echo.addEventListener('animationend', () => echo.remove(), { once: true });
  }, { passive: true });
  listen(document, 'pointerup', () => cursor.classList.remove('is-down'), { passive: true });

  function updateOverlay() {
    const show = viewModes[store.get().activeTab] ?? false;
    $('view-natural').setAttribute('aria-pressed', String(!show));
    $('view-anomaly').setAttribute('aria-pressed', String(show));
    if (show !== previousOverlay) { previousOverlay = show; onOverlayVisibility(show); }
  }
  listen($('view-natural'), 'click', () => { viewModes[store.get().activeTab] = false; updateOverlay(); });
  listen($('view-anomaly'), 'click', () => { viewModes[store.get().activeTab] = true; updateOverlay(); });

  function render(state) {
    const { lang, activeTab, history, audio, selectedPoint } = state;
    const [title, intro] = headings[activeTab] ?? headings.history;
    $('experience-title').textContent = t(lang, title);
    $('experience-subtitle').textContent = t(lang, intro);
    $('history-stage').hidden = activeTab !== 'history';
    $('history-empty').hidden = history.status === 'ready';
    $('history-form').setAttribute('aria-busy', String(history.status === 'loading'));
    $('history-submit').disabled = history.status === 'loading';
    for (const [selector, epoch] of [['.compare-before', 'a'], ['.compare-after', 'b']]) {
      $('history-result').querySelector(selector)?.classList.toggle('is-playing',
        Boolean(activeTab === 'history' && !audio.muted && history.playing?.epoch === epoch && history.playing?.phase === 'music'));
    }
    if (selectedPoint) {
      $('globe-label').hidden = false;
      const result = history.result;
      const isStoryPoint = result?.point.lat === selectedPoint.lat && result?.point.lon === selectedPoint.lon;
      $('globe-place-name').textContent = isStoryPoint && result.placeLabel ? result.placeLabel : formatCoords(selectedPoint.lat, selectedPoint.lon);
    } else $('globe-label').hidden = true;
    if (audio.started && !analyser && audioEngine.Tone?.Analyser) {
      // Read the real master bus. This analyser is never connected to Destination.
      analyser = new audioEngine.Tone.Analyser('waveform', 128);
      audioEngine.getBus().connect(analyser);
    }
    if (previousLang !== lang) { previousLang = lang; syncEffects(); }
    if (previousTab !== activeTab) {
      previousTab = activeTab;
      updateOverlay();
      onViewChange?.(activeTab);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    document.querySelector('.share-local-note').textContent = t(lang, local ? 'shareLocalNote' : 'auroraSharePublic');
  }

  const resizeObserver = new ResizeObserver(resizeWave);
  resizeObserver.observe(waveCanvas);
  const intersectionObserver = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; syncWaveLoop(); });
  intersectionObserver.observe(waveCanvas);
  resizeTrail(); resizeWave(); syncEffects(); render(store.get());
  return {
    render,
    dispose() {
      listeners.abort(); resizeObserver.disconnect(); intersectionObserver.disconnect();
      cancelAnimationFrame(waveFrame); cancelAnimationFrame(trailFrame); hideCursor();
      if (analyser) { audioEngine.getBus()?.disconnect(analyser); analyser.dispose(); }
    }
  };
}
