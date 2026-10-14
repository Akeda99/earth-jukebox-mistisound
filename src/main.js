import './styles.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as Cesium from 'cesium';

import { t, getStoredLang, setStoredLang, availableLangs } from './i18n/index.js';
import { createStore, createInitialState } from './state/store.js';
import { GistempRepository, LruCache } from './data/repository.js';
import { PowerRepository } from './data/power-repository.js';
import { IceRepository } from './data/sea-ice-repository.js';
import { findNearestCell } from './data/grid.js';
import { createGlobe, localizeGlobeWidgets } from './globe/create-globe.js';
import { addGibsBaseLayer } from './globe/imagery.js';
import { setupPicking } from './globe/picking.js';
import { createOverlayProvider, addOverlayLayer, removeOverlayLayer } from './globe/numeric-overlay.js';
import { AudioEngine } from './audio/engine.js';
import { createControls, createLangSwitch } from './ui/controls.js';
import { createTimeline } from './ui/timeline.js';
import { createPeruPanel } from './ui/peru-panel.js';
import { createAccessiblePanel } from './ui/accessible-panel.js';
import { createDjPanel } from './ui/dj-panel.js';
import { createEicPanel } from './ui/eic-panel.js';
import { createHistoryPanel } from './ui/history-panel.js';
import { createHistoryController } from './history/history-controller.js';
import { loadCityCatalog } from './history/cities.js';
import { DjMixer } from './audio/mixer.js';
import { createTabs } from './ui/tabs.js';
import { createShare, resolvePresetPeriod, ALLOWED_DJ_CHANNELS } from './sharing/preset.js';
import { createNarrator } from './accessibility/narration.js';
import { setupKeyboardSupport } from './accessibility/keyboard.js';
import { createActionCoordinator, runGuardedAction } from './app/action-coordinator.js';

const DATA_BASE_URL = `${import.meta.env.BASE_URL}data/`;

const store = createStore(createInitialState({ lang: getStoredLang() }));
const audioEngine = new AudioEngine();
const narrator = createNarrator({ audioEngine });

let overlayLayer = null;
let overlayGeneration = 0;
let globeHandle = null;
let pointMarker = null;

function applyStaticTexts() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(store.get().lang, el.getAttribute('data-i18n'));
  }
}

function setLang(lang) {
  if (!availableLangs().includes(lang)) return;
  setStoredLang(lang);
  document.documentElement.lang = lang;
  store.set({ lang });
  applyStaticTexts();
  localizeGlobeWidgets(globeHandle?.viewer, lang);
  narrator.cancel();
}

function pointKeyFromCell(cell) {
  return cell ? `${cell.latIdx}:${cell.lonIdx}` : null;
}

/**
 * Calcula, sin tocar el store, la celda GISTEMP mas cercana a un punto y la
 * comparacion A/B resultante (invalidada si el punto cae en una celda
 * distinta de la que se estaba comparando). Pura por diseno: el llamador
 * decide en que UNICO store.set se aplica junto con el resto de campos
 * relacionados (dataset/periodo o selectedPoint), para que ningun
 * suscriptor (en particular el audio) pueda observar un periodo/punto
 * nuevo con una celda todavia vieja entre dos renders.
 */
function computeCellAndCompare({ selectedPoint, dataset, compare }) {
  if (!selectedPoint || !dataset) {
    return { cell: null, compare: compare ?? { a: null, b: null, pointKey: null } };
  }
  const cell = findNearestCell(selectedPoint.lat, selectedPoint.lon, dataset);
  const pointKey = pointKeyFromCell(cell);
  if (compare?.pointKey && compare.pointKey !== pointKey) {
    return { cell, compare: { a: null, b: null, pointKey: null } };
  }
  return { cell, compare };
}

function maybeSonifySelectedCell() {
  const { audio, cell, dj } = store.get();
  // Mientras el DJ esta mezclando, el canal de temperatura YA sonifica esta
  // misma celda en cada pulso (ver audio/mixer.js): la nota simple de
  // "seleccionar punto" se omite para no duplicarla/solaparla.
  if (dj.playing) return;
  if (audio.started && !audio.muted && cell && cell.value !== null) {
    audioEngine.playAnomaly(cell.value);
  }
}

function placeMarker(lat, lon) {
  if (!globeHandle?.viewer) return;
  const position = Cesium.Cartesian3.fromDegrees(lon, lat);
  if (pointMarker) {
    pointMarker.position = position;
  } else {
    pointMarker = globeHandle.viewer.entities.add({
      position,
      point: {
        pixelSize: 12,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.NONE
      }
    });
  }
  globeHandle.viewer.scene.requestRender();
}

/**
 * Carga un periodo y, si termina de resolver, confirma el dataset y
 * actualiza el overlay numerico en el globo (si hay un visor disponible).
 *
 * Maneja la concurrencia con un contador de generacion: cada llamada arranca
 * una nueva generacion, y SOLO la ultima generacion viva en cada punto de
 * espera (await) puede llegar a comprometer store/imagen/nota. Una
 * respuesta vieja que llega tarde se descarta por completo (incluyendo el
 * proveedor de imagen ya preparado, si alguno) sin tocar la capa
 * actualmente visible.
 */
// Contrato explicito de retorno (ver revision: antes siempre devolvia
// undefined, exito y fallo indistinguibles para el llamador, que aplicaba
// selectPoint/sonido igual aunque el periodo hubiera fallado o la llamada
// ya fuera obsoleta):
//  - { ok: true, period } el periodo se confirmo y el llamador puede
//    continuar (p.ej. aplicar el punto seleccionado).
//  - { ok: false, reason: 'not-found' | 'error' | 'stale' } el periodo NO
//    se confirmo: 'not-found' (no existe en el manifiesto), 'error' (fallo
//    la carga), 'stale' (una llamada a changePeriod mas reciente ya
//    reemplazo esta). El llamador NUNCA debe aplicar punto ni sonificar en
//    ninguno de estos casos.
async function changePeriod(repository, period, { sonify = true } = {}) {
  if (!repository.hasPeriod(period)) return { ok: false, reason: 'not-found' };
  overlayGeneration += 1;
  const generation = overlayGeneration;

  store.set({ requestedPeriod: period, periodError: null });

  let result;
  try {
    result = await repository.loadPeriod(period);
  } catch (err) {
    if (generation !== overlayGeneration) return { ok: false, reason: 'stale' }; // una solicitud mas nueva ya la reemplazo
    console.error(`No se pudo cargar el periodo ${period}`, err);
    store.set({ periodError: period });
    return { ok: false, reason: 'error' };
  }
  if (!result) return { ok: false, reason: 'stale' }; // loadPeriod ya superado por otra llamada (ver repository.js)
  if (generation !== overlayGeneration) return { ok: false, reason: 'stale' };

  // Si el overlay visual falla, el dataset sigue siendo valido para
  // panel/sonificacion, pero NUNCA se deja la imagen del overlay anterior
  // visible con la etiqueta del periodo nuevo: se retira esa capa y se
  // marca `overlayError` para que la UI muestre un aviso traducido en vez
  // de un estado ambiguo (imagen vieja + texto nuevo).
  let newLayer = null;
  let overlayFailed = false;
  if (globeHandle?.viewer) {
    try {
      const provider = await createOverlayProvider(result.data);
      if (generation !== overlayGeneration) return { ok: false, reason: 'stale' }; // descartado: ya no es la mas reciente
      newLayer = addOverlayLayer(globeHandle.viewer, provider);
    } catch (err) {
      if (generation !== overlayGeneration) return { ok: false, reason: 'stale' };
      console.error('No se pudo preparar el overlay numerico', err);
      overlayFailed = true;
    }
  }

  if (generation !== overlayGeneration) {
    if (newLayer && globeHandle?.viewer) removeOverlayLayer(globeHandle.viewer, newLayer);
    return { ok: false, reason: 'stale' };
  }

  if (overlayLayer && overlayLayer !== newLayer && globeHandle?.viewer) {
    removeOverlayLayer(globeHandle.viewer, overlayLayer);
  }
  overlayLayer = newLayer; // null si fallo: nunca queda la capa anterior con la etiqueta del periodo nuevo

  // Dataset, periodo y celda recalculada en UN SOLO store.set: ningun
  // suscriptor (en particular el motor de audio/DJ) puede observar un
  // periodo nuevo todavia con la celda del periodo anterior entre dos
  // renders separados.
  const nextState = store.get();
  const { cell, compare } = computeCellAndCompare({
    selectedPoint: nextState.selectedPoint,
    dataset: result.data,
    compare: nextState.compare
  });
  store.set({
    confirmedPeriod: result.requestedPeriod,
    dataset: result.data,
    periodError: null,
    overlayError: overlayFailed ? result.requestedPeriod : null,
    cell,
    compare
  });
  if (sonify) maybeSonifySelectedCell();
  return { ok: true, period: result.requestedPeriod };
}

async function init() {
  document.documentElement.lang = store.get().lang;
  applyStaticTexts();

  // Coordinador de concurrencia: se crea ANTES de registrar cualquier
  // callback (picking del globo, timeline) y antes del primer `await` de
  // init() (createPeruPanel): selectPoint/onPeriodChange ya lo usan dentro
  // de sus cuerpos, y aunque esos cuerpos solo se ejecutan tras un evento
  // posterior, declararlo despues de registrarlos dejaba una zona muerta
  // temporal (TDZ) innecesaria entre su registro y su inicializacion.
  const actionCoordinator = createActionCoordinator();
  let historyController = null;

  const langSwitch = createLangSwitch({ store, onChange: setLang });
  const tabs = createTabs({ store });

  let manifest;
  try {
    const res = await fetch(`${DATA_BASE_URL}manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    console.error('No se pudo cargar manifest.json', err);
    manifest = { files: [] };
  }

  const repository = new GistempRepository({ baseUrl: DATA_BASE_URL, manifest });
  const availablePeriods = repository.availablePeriods;
  const powerRepository = new PowerRepository({ baseUrl: DATA_BASE_URL });

  // dj-index.json es el indice PROPIO de los datasets del grupo DJ
  // (precipitacion/incendios/hielo, ver scripts/dj_index_common.py),
  // independiente de manifest.json. Si no existe o falla, el hielo queda
  // simplemente sin serie disponible (iceRepository.availablePeriods
  // vacio) en vez de romper el resto de la app.
  let djIndex = {};
  try {
    const res = await fetch(`${DATA_BASE_URL}dj-index.json`);
    if (res.ok) djIndex = await res.json();
  } catch (err) {
    console.error('No se pudo cargar dj-index.json (hielo quedara sin serie disponible)', err);
  }
  const iceRepository = new IceRepository({
    baseUrl: DATA_BASE_URL,
    periods: djIndex?.sea_ice_g02135?.periods ?? []
  });

  globeHandle = createGlobe(document.getElementById('globe-container'));
  if (import.meta.env.DEV && globeHandle.viewer) window.__ejViewer = globeHandle.viewer;
  if (!globeHandle.viewer) {
    console.error('No se pudo crear el globo (WebGL no disponible)', globeHandle.error);
    document.getElementById('globe-fallback').hidden = false;
  } else {
    localizeGlobeWidgets(globeHandle.viewer, store.get().lang);
    addGibsBaseLayer(globeHandle.viewer, {
      onError: (err) => {
        console.error('Error cargando capa GIBS', err);
        document.getElementById('gibs-warning').hidden = false;
      }
    });

    setupPicking(globeHandle.viewer, ({ lat, lon }) => {
      selectPoint(lat, lon);
    });

    // El rediseno cambia el ancho/alto del globo segun el modo y el viewport:
    // se reajusta el canvas y se pide UN render (sin animacion continua).
    if (typeof ResizeObserver !== 'undefined') {
      let resizeFrame = 0;
      const viewerForResize = globeHandle.viewer;
      new ResizeObserver(() => {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          viewerForResize.resize();
          viewerForResize.scene.requestRender();
        });
      }).observe(document.getElementById('globe-container'));
    }
  }

  function selectPoint(lat, lon, { fly = false, sonify = true, internal = false } = {}) {
    // Cualquier seleccion directa (clic en el globo/Peru) es, por
    // definicion, la accion mas reciente: invalida cualquier Consultar/
    // preset que todavia este esperando un periodo (ver action-coordinator)
    // y cualquier consulta/escucha de "Tu historia": esa accion vieja no
    // podra pisar esta seleccion cuando termine. `internal` (la propia
    // historia mostrando su lugar) no se autocancela ni invalida presets.
    if (!internal) {
      actionCoordinator.startAction();
      historyController?.cancelQuery();
    }
    // Un UNICO store.set con el punto nuevo, su celda recalculada y la
    // comparacion A/B invalidada si corresponde: ninguna seleccion nueva
    // deja, entre dos renders, una celda/comparacion/lluvia del punto
    // anterior visible junto a coordenadas nuevas.
    const prev = store.get();
    const selectedPoint = { lat, lon };
    const { cell, compare } = computeCellAndCompare({ selectedPoint, dataset: prev.dataset, compare: prev.compare });
    store.set({ selectedPoint, cell, compare });
    placeMarker(lat, lon);
    if (sonify) maybeSonifySelectedCell();
    if (fly && globeHandle?.viewer) {
      flyToPoint(lat, lon);
    }
  }

  function flyToPoint(lat, lon) {
    if (!globeHandle?.viewer) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const destination = Cesium.Cartesian3.fromDegrees(lon, lat, 1_500_000);
    if (reducedMotion) {
      globeHandle.viewer.camera.setView({ destination });
    } else {
      globeHandle.viewer.camera.flyTo({ destination, duration: 1.5 });
    }
  }

  function handleListen() {
    const { cell } = store.get();
    if (cell) audioEngine.playAnomaly(cell.value);
  }

  function handleCompareA() {
    const { cell, confirmedPeriod } = store.get();
    if (!cell) return;
    const pointKey = pointKeyFromCell(cell);
    store.set((s) => ({
      compare: { ...s.compare, a: { period: confirmedPeriod, value: cell.value }, pointKey }
    }));
  }

  function handleCompareB() {
    const { cell, confirmedPeriod, compare } = store.get();
    if (!cell || !compare.a) return;
    store.set((s) => ({ compare: { ...s.compare, b: { period: confirmedPeriod, value: cell.value } } }));
  }

  function handleListenCompare(which) {
    const { compare } = store.get();
    const snapshot = compare[which];
    if (snapshot) audioEngine.playAnomaly(snapshot.value);
  }

  const controls = createControls({
    store,
    audioEngine,
    narrator,
    onListen: handleListen,
    onCompareA: handleCompareA,
    onCompareB: handleCompareB,
    onListenCompare: handleListenCompare
  });

  const timeline = createTimeline({
    store,
    availablePeriods,
    onPeriodChange: (period, opts) => {
      // Elegir periodo en la linea de tiempo es tambien una accion directa
      // del usuario: invalida cualquier Consultar/preset en vuelo (ver
      // action-coordinator) para que no le pise este periodo mas tarde.
      actionCoordinator.startAction();
      historyController?.cancelQuery();
      return changePeriod(repository, period, opts);
    },
    onTogglePlay: () => store.set((s) => ({ playback: { playing: !s.playback.playing } }))
  });

  const peruPanel = await createPeruPanel({
    store,
    onVisit: (lat, lon) => selectPoint(lat, lon, { fly: true }),
    narrator,
    viewer: globeHandle?.viewer ?? null
  });

  const accessiblePanel = createAccessiblePanel({
    store,
    repository,
    narrator,
    onQuery: async ({ lat, lon, period }) => {
      // runGuardedAction (src/app/action-coordinator.js, el mismo runner
      // que prueban tests/action-coordinator.test.js): solo aplica el
      // punto si el periodo se confirmo Y esta consulta sigue vigente.
      await runGuardedAction(actionCoordinator, {
        run: () => (period ? changePeriod(repository, period, { sonify: false }) : Promise.resolve({ ok: true })),
        onSuccess: () => selectPoint(lat, lon)
      });
    },
    onDescribe: () => describeCurrentState(),
    onListen: handleListen,
    onCompareA: handleCompareA,
    onCompareB: handleCompareB
  });

  const djPanel = createDjPanel({
    store,
    audioEngine,
    powerRepository,
    iceRepository,
    // "Explorar hemisferios": mismo gesto que visitar un lugar de Peru
    // (selectPoint + vuelo de camara si el globo esta disponible).
    onExplorePoint: (lat, lon) => selectPoint(lat, lon, { fly: true })
  });
  const eicPanel = createEicPanel({ store, audioEngine });
  // dj-panel/eic-panel construyen su DOM con data-i18n DESPUES de la
  // primera applyStaticTexts() de arriba: se vuelve a aplicar para que sus
  // textos no queden vacios en el primer render.

  // Tu historia: repositorio PROPIO (LRU de 2 meses) y mezclador propio, para
  // no competir con el periodo del globo ni con los canales del DJ.
  const historyRepository = new GistempRepository({
    baseUrl: DATA_BASE_URL,
    manifest,
    cache: new LruCache(2)
  });
  historyController = createHistoryController({
    store,
    repository: historyRepository,
    audioEngine,
    narrator,
    createMixer: () =>
      new DjMixer({
        ToneLib: audioEngine.Tone,
        bus: audioEngine.getBus(),
        seed: store.get().dj.seed || 'earth-jukebox',
        bpm: store.get().dj.bpm
      }),
    onShowPoint: (lat, lon) => selectPoint(lat, lon, { fly: true, sonify: false, internal: true }),
    onShowEpoch: async (period) => {
      const r = await changePeriod(repository, period, { sonify: false });
      const s = store.get();
      if (r.ok && s.confirmedPeriod === period && s.overlayError !== period) return { ok: true };
      return { ok: false, reason: r.reason ?? 'overlay' };
    }
  });
  const historyPanel = createHistoryPanel({
    store,
    controller: historyController,
    repository: historyRepository,
    loadCities: () => loadCityCatalog({ baseUrl: DATA_BASE_URL }),
    getGlobePoint: () => store.get().selectedPoint,
    narrator
  });
  applyStaticTexts();

  function describeCurrentState() {
    const { lang, selectedPoint, cell, dataset, audio } = store.get();
    return accessiblePanel.describeState({ lang, selectedPoint, cell, dataset, audio });
  }

  // "Voz de navegacion" (opt-in, default OFF, ver store.js/accessible-panel.js):
  // anuncia por voz el estado CONFIRMADO (punto/periodo/celda) con debounce,
  // sin leer cada input de slider. Nunca narra con mute global activo ni al
  // abrir un enlace (narrationAuto no se restaura desde preset: siempre
  // arranca en false). narrator.speak() ya cancela cualquier narracion
  // anterior antes de hablar (ver accessibility/narration.js).
  const NARRATION_DEBOUNCE_MS = 700;
  let narrationDebounceHandle = null;
  let lastAnnouncedKey = null;
  function maybeAutoNarrate(state) {
    if (!state.narrationAuto || state.audio.muted) return;
    const key = JSON.stringify({
      lat: state.selectedPoint?.lat,
      lon: state.selectedPoint?.lon,
      period: state.confirmedPeriod,
      value: state.cell?.value
    });
    if (key === lastAnnouncedKey) return;
    lastAnnouncedKey = key;
    if (narrationDebounceHandle) clearTimeout(narrationDebounceHandle);
    narrationDebounceHandle = setTimeout(() => {
      const current = store.get();
      if (!current.narrationAuto || current.audio.muted) return;
      narrator.speak(describeCurrentState(), current.lang);
    }, NARRATION_DEBOUNCE_MS);
  }

  const share = createShare({
    store,
    getSnapshot: () => {
      const { selectedPoint, confirmedPeriod, lang, dataset, dj, activeTab, history } = store.get();
      const story = activeTab === 'history' && history.status === 'ready' ? history.result : null;
      // Volumen maestro/mute NUNCA se incluyen (son personales del
      // dispositivo que genera el enlace). Las ganancias POR CANAL del DJ
      // si, porque son parte de la mezcla que se comparte. dataVersions usa
      // el hash original de GISTEMP del periodo actual (si ya se cargo
      // alguno) y el data_version de POWER de la ultima lluvia resuelta
      // para el punto (si DJ ya la consulto) — nunca se confunde con
      // PRESET_VERSION (version del esquema del enlace, no del dato).
      return {
        mode: activeTab,
        selectedPoint: story ? story.point : selectedPoint,
        period: story ? story.b.period : confirmedPeriod,
        history: story ? { a: story.a.period, b: story.b.period } : undefined,
        lang,
        seed: dj.seed,
        bpm: dj.bpm,
        channels: {
          temperature: {
            enabled: dj.channels.temperature.enabled,
            gainDb: dj.channels.temperature.gainDb,
            solo: dj.channels.temperature.solo
          },
          rain: { enabled: dj.channels.rain.enabled, gainDb: dj.channels.rain.gainDb, solo: dj.channels.rain.solo },
          ice: { enabled: dj.channels.ice.enabled, gainDb: dj.channels.ice.gainDb, solo: dj.channels.ice.solo }
        },
        dataVersions: {
          gistemp: story ? story.sourceSha : (dataset?.source?.original_file_sha256 ?? null),
          power: dj.rainInfo?.dataVersion ?? null,
          seaIce: dj.iceInfo?.versionHash ?? null
        }
      };
    },
    onApplyPreset: async (preset) => {
      const token = actionCoordinator.startAction();
      if (preset.lang) setLang(preset.lang);
      // El modo (pestana) SI se restaura: un preset guardado desde DJ debe
      // reabrir en DJ, no quedarse silenciosamente en Explorar.
      if (preset.mode) store.set({ activeTab: preset.mode });
      if (preset.history && preset.selectedPoint) {
        // Enlace de historia: rellena formulario y resultado, SIN audio.
        store.set((s) => ({
          composition: { playing: false, ended: false },
          dj: {
            ...s.dj,
            playing: false,
            seed: typeof preset.seed === 'string' || typeof preset.seed === 'number' ? preset.seed : s.dj.seed,
            bpm: typeof preset.bpm === 'number' ? preset.bpm : s.dj.bpm
          }
        }));
        const outcome = await historyPanel.showShared({ point: preset.selectedPoint, a: preset.history.a, b: preset.history.b });
        if (outcome.ok && preset.dataVersions?.gistemp && outcome.result.sourceSha && preset.dataVersions.gistemp !== outcome.result.sourceSha) {
          share.setWarning(t(store.get().lang, 'shareErrorDataVersion', { field: 'gistemp' }));
        }
        return;
      }
      let periodFailed = false;
      if (preset.period) {
        const resolved = resolvePresetPeriod(preset.period, repository.availablePeriods);
        if (resolved.ok && resolved.period) {
          const periodResult = await changePeriod(repository, resolved.period, { sonify: false });
          periodFailed = !periodResult.ok;
        } else {
          periodFailed = true;
        }
        if (periodFailed && actionCoordinator.isCurrent(token)) {
          // Periodo del preset ya no existe o fallo al cargar: se informa
          // explicitamente (reutilizando el estado de error de la linea de
          // tiempo) en vez de sustituirlo en silencio por otro Y sin aplicar
          // el punto del preset sobre un periodo que nunca se confirmo.
          store.set({ periodError: preset.period });
        }
      }
      if (!actionCoordinator.isCurrent(token)) return; // una accion mas nueva ya lo reemplazo
      if (!periodFailed) {
        // Version del PAQUETE DE DATOS: si el preset se genero con un hash
        // GISTEMP distinto del periodo ya cargado, el dato pudo haber sido
        // revisado desde entonces; se avisa explicitamente en vez de fingir
        // que es exactamente la misma reproduccion.
        const loadedHash = store.get().dataset?.source?.original_file_sha256 ?? null;
        if (preset.dataVersions?.gistemp && loadedHash && preset.dataVersions.gistemp !== loadedHash) {
          share.setWarning(t(store.get().lang, 'shareErrorDataVersion', { field: 'gistemp' }));
        }
        if (preset.selectedPoint) {
          selectPoint(preset.selectedPoint.lat, preset.selectedPoint.lon);
        }
      }
      // Semilla, BPM y version de POWER esperada se restauran siempre que el
      // preset las traiga, incluso si no trae canales (p.ej. un enlace
      // compartido solo con punto/periodo) o si el periodo fallo (son datos
      // de la mezcla, no del punto/periodo); audio.started/muted/volumeDb
      // NUNCA se tocan aqui (ver sharing/preset.js, cabecera). dj.playing SI
      // se fuerza a false: abrir un enlace nunca es autoplay, ni continua
      // sonando una mezcla que ya estuviera activa antes de abrirlo.
      if (preset.legacyMusic) share.setWarning(t(store.get().lang, 'shareLegacyMusic'));
      store.set((s) => ({
        composition: { playing: false, ended: false },
        dj: {
          ...s.dj,
          playing: false,
          seed: typeof preset.seed === 'string' || typeof preset.seed === 'number' ? preset.seed : s.dj.seed,
          bpm: typeof preset.bpm === 'number' ? preset.bpm : s.dj.bpm,
          // Version de POWER esperada para la lluvia del punto del preset:
          // dj-panel la compara contra la version realmente resuelta al
          // consultar la lluvia de este punto, y avisa si no coincide.
          expectedDataVersion: preset.dataVersions?.power ?? s.dj.expectedDataVersion,
          // Mismo patron para hielo (version_hash de G02135 por periodo,
          // ver sharing/preset.js dataVersions.seaIce).
          expectedIceVersion: preset.dataVersions?.seaIce ?? s.dj.expectedIceVersion
        }
      }));
      // Las ganancias/activacion/solo por canal SOLO se restauran si el
      // preset realmente trae canales: determinan la cancion que suena.
      if (preset.channels && Object.keys(preset.channels).length > 0) {
        store.set((s) => ({
          dj: {
            ...s.dj,
            // Se fusiona sobre s.dj.channels (en vez de reemplazarlo
            // entero): fuegos/hielo no estan en ALLOWED_DJ_CHANNELS (sin
            // datos reales, ver sharing/preset.js) y Object.fromEntries
            // sobre solo esa lista los eliminaba por completo del store.
            channels: {
              ...s.dj.channels,
              ...Object.fromEntries(
                ALLOWED_DJ_CHANNELS.map((id) => {
                  const incoming = preset.channels[id];
                  // Un canal ausente en el preset (o sin datos reales, p.ej.
                  // fuegos/hielo) queda DESHABILITADO al aplicar: nunca
                  // conserva la mezcla por defecto previa, que cambiaria la
                  // cancion resultante sin que el preset lo pidiera.
                  if (!incoming) return [id, { ...s.dj.channels[id], enabled: false, solo: false }];
                  return [
                    id,
                    {
                      ...s.dj.channels[id],
                      enabled: Boolean(incoming.enabled),
                      gainDb: incoming.gainDb,
                      solo: Boolean(incoming.solo)
                    }
                  ];
                })
              )
            }
          }
        }));
      }
    }
  });

  setupKeyboardSupport({ store });

  store.subscribe((state) => {
    langSwitch.render(state);
    tabs.render(state);
    controls.render(state);
    timeline.render(state);
    peruPanel.render(state);
    accessiblePanel.render(state);
    djPanel.render(state);
    eicPanel.render(state);
    historyPanel.render(state);
    historyController.enforce(state);
    share.render(state);
    maybeAutoNarrate(state);
  });
  langSwitch.render(store.get());
  tabs.render(store.get());
  controls.render(store.get());
  timeline.render(store.get());
  peruPanel.render(store.get());
  accessiblePanel.render(store.get());
  djPanel.render(store.get());
  eicPanel.render(store.get());
  historyPanel.render(store.get());
  share.render(store.get());

  await share.applyFromUrlIfPresent();

  if (availablePeriods.length > 0) {
    const defaultPeriod = store.get().confirmedPeriod ?? availablePeriods[availablePeriods.length - 1];
    const periodToLoad = repository.hasPeriod(defaultPeriod) ? defaultPeriod : availablePeriods[availablePeriods.length - 1];
    timeline.setPeriodSelects(periodToLoad);
    await changePeriod(repository, periodToLoad, { sonify: false });
  }

  if (store.get().selectedPoint) {
    const { lat, lon } = store.get().selectedPoint;
    placeMarker(lat, lon);
  }
}

init();
