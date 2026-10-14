// Presets compartibles: version + modo + coordenadas + periodo + idioma +
// capas (hoy solo GISTEMP) + semilla futura + ganancias, codificados en el
// fragmento de la URL (#p=...) y, opcionalmente, guardados en
// localStorage con un nombre. Pensado para no depender de ningun backend.
//
// Reglas de seguridad/robustez explicitas:
//  - Se valida tipo, rango y longitud de CADA campo; nada se acepta "tal
//    cual" desde una URL (que es entrada no confiable).
//  - "layers" usa una whitelist fija; cualquier valor fuera de ella se
//    descarta (nunca se ejecuta ni interpreta como codigo/selector).
//  - Un periodo con formato invalido, una version desconocida, o una
//    longitud de fragmento excesiva se reportan como error explicito: NUNCA
//    se sustituye en silencio por un valor por defecto sin avisar.
//  - El texto derivado de la URL/preset se vuelca SIEMPRE con textContent
//    (nunca innerHTML) en cualquier parte de la UI que lo muestre.
//  - Abrir un enlace con preset NUNCA activa audio ni cambia el mute/volumen
//    personal ya elegido por quien abre el enlace (ver createShare /
//    main.js: onApplyPreset solo toca periodo/punto/idioma).

import { t } from '../i18n/index.js';
import { MUSIC_VERSION, MUSIC_STYLE, MUSIC_MOTIF } from '../config/sonification.js';
import { COMPOSITION_SECONDS } from '../audio/composition.js';

// v2 (fase 5, extendido en fase 9 para hielo): antes "layers" codificaba
// SIEMPRE ALLOWED_LAYERS completo (ignoraba lo que el usuario realmente
// elegia). Ahora codifica solo los canales DJ realmente activos/elegidos
// (temperatura/lluvia/hielo, los 3 reales disponibles hoy; ver
// src/audio/mixer.js), su ganancia por canal y la semilla. Agregar 'ice' a
// ALLOWED_DJ_CHANNELS es un cambio ADITIVO dentro del mismo esquema v2 (un
// enlace v2 viejo sin canal de hielo sigue decodificando igual: el campo
// simplemente esta ausente); no se bumpea PRESET_VERSION por esto. Un canal
// desconocido en el enlace se INFORMA como error explicito (campo
// invalido), nunca se descarta en silencio. El volumen maestro y el mute
// personal NUNCA viajan en el preset (son del dispositivo/usuario que abre
// el enlace, no del dato compartido); solo las ganancias POR CANAL del DJ
// si, porque son parte de la mezcla que se esta compartiendo.
// v3 (tarea 14): igual que v2 mas el bloque `music` {v, style, motif, dur}
// que identifica la version musical (mapeo -12..12 asinh, motivo, duracion).
// Un enlace v2 sigue abriendo (sin autoplay) pero se marca legacyMusic: su
// mapeo era lineal -5..5 y la app NO afirma que suene igual. Una version
// musical desconocida se informa como error explicito.
// Tarea 15 (aditivo dentro de v3): modo 'history' y bloque opcional
// `h` {a, b} con SOLO dos periodos AAAA-MM (mes de nacimiento y periodo de
// comparacion) mas el punto lat/lon ya existente. Nunca viaja fecha exacta,
// nombre, edad ni el nombre de la ciudad elegida. Un enlace sin `h` abre igual.
export const PRESET_VERSION = 3;
export const LEGACY_PRESET_VERSION = 2;
export const MAX_FRAGMENT_LENGTH = 2000;
export const ALLOWED_LANGS = ['es', 'en'];
// Canales DJ reales con datos disponibles hoy (ver docs/dj-data-sources.md
// y docs/pending-data-research.md): incendios sigue bloqueado por
// autenticacion NASA (FIRMS), nunca se codifica como si tuviera mezcla
// real. Hielo (NOAA/NSIDC G02135, 2023 completo) SI tiene datos reales
// desde fase 9: ver src/data/sea-ice-repository.js.
export const ALLOWED_DJ_CHANNELS = ['temperature', 'rain', 'ice'];
export const ALLOWED_MODES = ['explore', 'peru', 'accessible', 'dj', 'history'];

const GAIN_DB_MIN = -40;
const GAIN_DB_MAX = 0;
const MAX_SEED_LENGTH = 64;
// BPM_MIN/BPM_MAX (ver audio/mixer.js) duplicados aqui a proposito: este
// modulo no depende de Tone/mixer.js (preset.js se usa tambien fuera del
// navegador, en pruebas sin Tone), y el rango del pulso es una decision
// musical fija documentada en ambos lugares.
const BPM_MIN = 48;
const BPM_MAX = 96;

const PERIOD_RE = /^\d{4}-\d{2}$/;

function isFiniteNumberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function toBase64Url(json) {
  const base64 = btoa(unescape(encodeURIComponent(json)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

/**
 * Codifica un preset a una cadena compacta para el fragmento de la URL.
 * Solo incluye los campos soportados (whitelist), nunca el objeto completo
 * del store. `channels` codifica UNICAMENTE los canales DJ realmente
 * elegidos por quien comparte (no fuerza la lista completa), con su
 * ganancia; `dataVersions` guarda la version del paquete de datos (hash
 * original GISTEMP por periodo, `data_version` de POWER, `version_hash`
 * de hielo G02135 por periodo bajo la clave `seaIce`) para que quien abre
 * el enlace pueda saber si esta viendo el mismo dato o uno que cambio.
 * NUNCA incluye volumen maestro ni mute (personales, no compartibles).
 */
export function encodePreset(preset) {
  const channels = {};
  if (preset.channels && typeof preset.channels === 'object') {
    for (const id of ALLOWED_DJ_CHANNELS) {
      const ch = preset.channels[id];
      if (!ch) continue;
      channels[id] = {
        enabled: Boolean(ch.enabled),
        gainDb: typeof ch.gainDb === 'number' ? ch.gainDb : 0,
        solo: Boolean(ch.solo)
      };
    }
  }
  const payload = {
    v: PRESET_VERSION,
    mode: ALLOWED_MODES.includes(preset.mode) ? preset.mode : 'explore',
    lat: preset.selectedPoint ? preset.selectedPoint.lat : null,
    lon: preset.selectedPoint ? preset.selectedPoint.lon : null,
    period: typeof preset.period === 'string' ? preset.period : null,
    lang: ALLOWED_LANGS.includes(preset.lang) ? preset.lang : 'es',
    seed: preset.seed ?? null,
    // BPM determina la cancion igual que las ganancias/canales: forma parte
    // de la mezcla compartida, no del volumen/mute personal.
    bpm: typeof preset.bpm === 'number' ? preset.bpm : undefined,
    channels: Object.keys(channels).length > 0 ? channels : undefined,
    dataVersions: preset.dataVersions && typeof preset.dataVersions === 'object' ? preset.dataVersions : undefined,
    music: { v: MUSIC_VERSION, style: MUSIC_STYLE, motif: MUSIC_MOTIF, dur: COMPOSITION_SECONDS },
    h:
      preset.history && PERIOD_RE.test(preset.history.a ?? '') && PERIOD_RE.test(preset.history.b ?? '')
        ? { a: preset.history.a, b: preset.history.b }
        : undefined
  };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decodifica y VALIDA una cadena de preset. Nunca lanza: siempre devuelve
 * { ok: true, preset } o { ok: false, error, fields? }, para que el
 * llamador pueda informar al usuario sin un try/catch propio ni un
 * `catch` silencioso que esconda el problema.
 */
export function decodePreset(fragment) {
  if (typeof fragment !== 'string' || fragment.length === 0) {
    return { ok: false, error: 'empty' };
  }
  if (fragment.length > MAX_FRAGMENT_LENGTH) {
    return { ok: false, error: 'tooLong' };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(fragment));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'malformed' };
  }
  if (payload.v !== PRESET_VERSION && payload.v !== LEGACY_PRESET_VERSION) {
    return { ok: false, error: 'unknownVersion', version: payload.v };
  }
  let music = null;
  if (payload.v === PRESET_VERSION && payload.music !== undefined) {
    const m = payload.music;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'invalidFields', fields: ['music'] };
    if (m.v !== MUSIC_VERSION) return { ok: false, error: 'unknownMusicVersion', version: m.v };
    if (m.style !== MUSIC_STYLE || m.motif !== MUSIC_MOTIF || m.dur !== COMPOSITION_SECONDS) {
      return { ok: false, error: 'invalidFields', fields: ['music'] };
    }
    music = { version: m.v, style: m.style, motif: m.motif, duration: m.dur };
  }
  const legacyMusic = music === null;

  const fields = [];

  let selectedPoint = null;
  const hasLat = payload.lat !== null && payload.lat !== undefined;
  const hasLon = payload.lon !== null && payload.lon !== undefined;
  if (hasLat || hasLon) {
    const latOk = isFiniteNumberInRange(payload.lat, -90, 90);
    const lonOk = isFiniteNumberInRange(payload.lon, -180, 180);
    if (!latOk) fields.push('lat');
    if (!lonOk) fields.push('lon');
    if (latOk && lonOk) selectedPoint = { lat: payload.lat, lon: payload.lon };
  }

  let period = null;
  if (payload.period !== null && payload.period !== undefined) {
    if (typeof payload.period === 'string' && /^\d{4}-\d{2}$/.test(payload.period)) {
      period = payload.period;
    } else {
      fields.push('period');
    }
  }

  let lang = 'es';
  if (payload.lang !== undefined) {
    if (ALLOWED_LANGS.includes(payload.lang)) lang = payload.lang;
    else fields.push('lang');
  }

  let mode = 'explore';
  if (payload.mode !== undefined) {
    if (ALLOWED_MODES.includes(payload.mode)) mode = payload.mode;
    else fields.push('mode');
  }

  // channels: SOLO canales DJ reales conocidos. Un canal desconocido
  // (nombre que no existe, p.ej. de una version futura/distinta de la app)
  // se INFORMA como campo invalido (fields.push) en vez de descartarse en
  // silencio: ver nota en encodePreset().
  let channels = {};
  if (payload.channels !== undefined) {
    if (!payload.channels || typeof payload.channels !== 'object' || Array.isArray(payload.channels)) {
      fields.push('channels');
    } else {
      let channelsOk = true;
      for (const [id, ch] of Object.entries(payload.channels)) {
        if (!ALLOWED_DJ_CHANNELS.includes(id)) {
          channelsOk = false;
          continue;
        }
        const gainOk = isFiniteNumberInRange(ch?.gainDb, GAIN_DB_MIN, GAIN_DB_MAX);
        if (typeof ch?.enabled !== 'boolean' || !gainOk || (ch?.solo !== undefined && typeof ch.solo !== 'boolean')) {
          channelsOk = false;
          continue;
        }
        channels[id] = { enabled: ch.enabled, gainDb: ch.gainDb, solo: Boolean(ch.solo) };
      }
      if (!channelsOk) {
        fields.push('channels');
        channels = {};
      }
    }
  }

  // dataVersions: version del PAQUETE DE DATOS (p.ej. hash original de cada
  // periodo GISTEMP, data_version de POWER), NUNCA confundir con PRESET_VERSION
  // (version del esquema del enlace, ya validada arriba). Solo se acepta si
  // son los campos conocidos con tipos razonables; un campo desconocido se
  // informa, no se descarta en silencio.
  let dataVersions = null;
  if (payload.dataVersions !== undefined) {
    if (!payload.dataVersions || typeof payload.dataVersions !== 'object' || Array.isArray(payload.dataVersions)) {
      fields.push('dataVersions');
    } else {
      const allowedKeys = ['gistemp', 'power', 'seaIce'];
      const entries = Object.entries(payload.dataVersions);
      const unknownKey = entries.some(([key]) => !allowedKeys.includes(key));
      const badType = entries.some(
        ([, value]) => value !== null && typeof value !== 'string' && typeof value !== 'number'
      );
      if (unknownKey || badType) {
        fields.push('dataVersions');
      } else {
        dataVersions = payload.dataVersions;
      }
    }
  }

  let history = null;
  if (payload.h !== undefined) {
    const h = payload.h;
    if (
      !h ||
      typeof h !== 'object' ||
      Array.isArray(h) ||
      Object.keys(h).some((k) => k !== 'a' && k !== 'b') ||
      !PERIOD_RE.test(h.a ?? '') ||
      !PERIOD_RE.test(h.b ?? '')
    ) {
      fields.push('history');
    } else {
      history = { a: h.a, b: h.b };
    }
  }

  let bpm = null;
  if (payload.bpm !== undefined) {
    if (isFiniteNumberInRange(payload.bpm, BPM_MIN, BPM_MAX)) {
      bpm = payload.bpm;
    } else {
      fields.push('bpm');
    }
  }

  let seed = null;
  if (payload.seed !== null && payload.seed !== undefined) {
    if (typeof payload.seed === 'string' && payload.seed.length <= MAX_SEED_LENGTH) {
      seed = payload.seed;
    } else if (typeof payload.seed === 'number' && Number.isFinite(payload.seed)) {
      seed = payload.seed;
    } else {
      fields.push('seed');
    }
  }

  if (fields.length > 0) {
    return { ok: false, error: 'invalidFields', fields };
  }

  return {
    ok: true,
    preset: { version: payload.v, mode, selectedPoint, period, lang, channels, dataVersions, seed, bpm, music, legacyMusic, history }
  };
}

/**
 * Resuelve si el periodo de un preset decodificado (formato ya validado)
 * existe de verdad en el manifiesto cargado. Un periodo con formato valido
 * pero que ya no existe (manifiesto cambiado, dato retirado, etc.) se
 * reporta como error explicito en vez de sustituirse en silencio por el
 * periodo actual o el mas reciente.
 */
export function resolvePresetPeriod(period, availablePeriods) {
  if (period === null || period === undefined) return { ok: true, period: null };
  if (!Array.isArray(availablePeriods) || !availablePeriods.includes(period)) {
    return { ok: false, error: 'periodNotFound', period };
  }
  return { ok: true, period };
}

const STORAGE_KEY = 'earth-jukebox-presets';
const MAX_SAVED_PRESETS = 20;

export function readSavedPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // storage bloqueado/corrupto: se trata como "sin guardados", no se lanza
  }
}

export function writeSavedPresets(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_SAVED_PRESETS)));
    return true;
  } catch {
    return false; // storage bloqueado (p.ej. modo privado/cuota llena): se ignora sin romper la UI
  }
}

/**
 * Conecta la UI de "Compartir" (boton de guardar/generar enlace, lista de
 * guardados) al store y a un `onApplyPreset(preset)` que el llamador
 * (main.js) usa para aplicar SOLO periodo/punto/idioma (nunca audio).
 */
export function createShare({ store, getSnapshot, onApplyPreset }) {
  const saveBtn = document.getElementById('share-save-btn');
  const urlOutput = document.getElementById('share-url');
  const errorEl = document.getElementById('share-error');
  const savedList = document.getElementById('share-saved-list');

  function currentMode() {
    return store.get().activeTab;
  }

  function buildUrl() {
    const snapshot = getSnapshot();
    const encoded = encodePreset({ ...snapshot, mode: currentMode() });
    const url = new URL(window.location.href);
    url.hash = `p=${encoded}`;
    return { url: url.toString(), encoded };
  }

  function renderSavedList() {
    if (!savedList) return;
    const saved = readSavedPresets();
    savedList.innerHTML = '';
    for (const entry of saved) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-btn';
      btn.textContent = entry.name; // nunca innerHTML con datos guardados por el usuario
      btn.addEventListener('click', () => {
        const result = decodePreset(entry.encoded);
        if (result.ok) onApplyPreset?.(result.preset);
      });
      li.appendChild(btn);
      savedList.appendChild(li);
    }
  }

  saveBtn?.addEventListener('click', () => {
    const { url, encoded } = buildUrl();
    if (urlOutput) urlOutput.value = url; // input.value, no innerHTML
    if (window.history?.replaceState) {
      window.history.replaceState(null, '', url);
    }
    const saved = readSavedPresets();
    const name = `${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    saved.unshift({ name, encoded });
    writeSavedPresets(saved);
    renderSavedList();
  });

  renderSavedList();

  async function applyFromUrlIfPresent() {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const encoded = params.get('p');
    if (!encoded) return;

    const result = decodePreset(encoded);
    if (!result.ok) {
      if (errorEl) errorEl.textContent = shareErrorMessage(result);
      return;
    }
    await onApplyPreset?.(result.preset);
  }

  function shareErrorMessage(result) {
    const lang = store.get().lang;
    if (result.error === 'unknownVersion') return t(lang, 'shareErrorVersion', { version: String(result.version) });
    if (result.error === 'unknownMusicVersion') return t(lang, 'shareErrorMusicVersion', { version: String(result.version) });
    if (result.error === 'tooLong') return t(lang, 'shareErrorTooLong');
    if (result.error === 'invalidFields') return t(lang, 'shareErrorFields', { fields: result.fields.join(', ') });
    return t(lang, 'shareErrorGeneric');
  }

  function render() {
    // El estado del share no depende de mas render que el inicial; se deja
    // el hook por consistencia con los demas modulos de UI.
  }

  /** Muestra un aviso (p.ej. version de dato incompatible al aplicar un
   * preset) en el mismo elemento que los errores de decodificacion. */
  function setWarning(text) {
    if (errorEl) errorEl.textContent = text ?? '';
  }

  return { render, applyFromUrlIfPresent, buildUrl, setWarning };
}
