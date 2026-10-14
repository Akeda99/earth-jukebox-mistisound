// Panel "DJ": mezcla en vivo de temperatura (GISTEMP, celda ya confirmada
// por el resto de la app), lluvia (NASA POWER, local para los 3 puntos de
// Peru o en vivo para cualquier otro punto) y hielo marino (NOAA/NSIDC
// G02135, serie 2023 completa, ver data/sea-ice-repository.js) del punto
// seleccionado. Incendios se muestra deshabilitado con el aviso "datos
// pendientes de autenticacion NASA" (ver docs/dj-data-sources.md): nunca
// se simula.
//
// Reglas de concurrencia (ver review de power-repository.js): cada cambio
// de punto/periodo arranca una nueva "generacion" de solicitud de
// lluvia/hielo (una por canal, independientes); solo la ultima generacion
// vigente de cada canal puede llegar a escribir en el store. Si el
// punto/periodo cambia mientras una solicitud esta en vuelo, la respuesta
// vieja se descarta por completo (nunca sigue sonando la lluvia/el hielo
// del punto/mes anterior).
import { t } from '../i18n/index.js';
import { DjMixer, BPM_MIN, BPM_MAX, rainToDensity } from '../audio/mixer.js';
import { describeSounding, COMPOSITION_SECONDS } from '../audio/composition.js';
import { MUSIC_ANOMALY_RANGE } from '../config/sonification.js';

const REAL_CHANNELS = ['temperature', 'rain', 'ice'];
const PENDING_CHANNELS = ['fires'];

// Puntos de ejemplo para "explorar hemisferios" con teclado (Tab/Enter/
// Espacio sobre botones nativos, ver accessibility/keyboard.js): cada uno
// es una coordenada REAL verificada independientemente contra el GeoTIFF
// original de enero 2023 (ver tests/dj-data/test_prepare_sea_ice_g02135.py
// y docs/pending-data-research.md), no un punto inventado/redondo. El
// valor de hielo que suena depende del periodo realmente seleccionado (no
// esta fijo a enero 2023).
export const ICE_EXPLORE_POINTS = [
  { id: 'arcticIce', lat: 75.19, lon: -133.67 },
  { id: 'arcticOcean', lat: 71.12, lon: -9.87 },
  { id: 'antarcticIce', lat: -68.66, lon: 37.18 },
  { id: 'antarcticOcean', lat: -55.9, lon: -84.91 }
];

function yearFromPeriod(period) {
  if (typeof period !== 'string') return null;
  const year = Number(period.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function pointPeriodKey(lat, lon, period) {
  return `${lat}:${lon}:${period}`;
}

export function createDjPanel({ store, audioEngine, powerRepository, iceRepository, onExplorePoint }) {
  const root = document.getElementById('dj-panel');
  if (!root) return { render: () => {} };

  root.innerHTML = '';
  const heading = document.createElement('h2');
  heading.setAttribute('data-i18n', 'djTitle');
  const intro = document.createElement('p');
  intro.setAttribute('data-i18n', 'djIntro');
  const statusEl = document.createElement('p');
  statusEl.id = 'dj-status';
  statusEl.setAttribute('role', 'status');
  const rainStatusEl = document.createElement('p');
  rainStatusEl.id = 'dj-rain-status';
  rainStatusEl.setAttribute('role', 'status');

  const iceStatusEl = document.createElement('p');
  iceStatusEl.id = 'dj-ice-status';
  iceStatusEl.setAttribute('role', 'status');

  // Leyenda de unidad del canal de temperatura (GISTEMP): texto estatico,
  // igual que djUnitsNote abajo explica PRECTOTCORR para lluvia. Reusa la
  // traduccion 'unitsEquivalenceNote' ya existente (hasta ahora definida
  // pero nunca mostrada en ninguna pantalla): una anomalia en K y en
  // grados Celsius es la MISMA magnitud (diferencia de temperatura, no
  // temperatura absoluta: nunca hace falta restar/sumar 273.15).
  const tempUnitsNoteEl = document.createElement('p');
  tempUnitsNoteEl.className = 'dj-temp-units-note';
  tempUnitsNoteEl.setAttribute('data-i18n', 'unitsEquivalenceNote');

  const channelsContainer = document.createElement('div');
  channelsContainer.id = 'dj-channels';

  const channelEls = {};
  for (const id of [...REAL_CHANNELS, ...PENDING_CHANNELS]) {
    const row = document.createElement('div');
    row.className = 'dj-channel-row';

    const title = document.createElement('span');
    title.className = 'dj-channel-title';
    title.setAttribute('data-i18n', `djChannel${id[0].toUpperCase()}${id.slice(1)}`);

    const enableBtn = document.createElement('button');
    enableBtn.type = 'button';
    enableBtn.className = 'action-btn dj-channel-enable';
    enableBtn.setAttribute('data-i18n', 'djChannelEnable');

    const soloBtn = document.createElement('button');
    soloBtn.type = 'button';
    soloBtn.className = 'icon-btn dj-channel-solo';
    soloBtn.setAttribute('data-i18n', 'djChannelSolo');
    soloBtn.setAttribute('aria-pressed', 'false');

    const gainLabel = document.createElement('label');
    gainLabel.setAttribute('data-i18n', 'djChannelGain');
    gainLabel.htmlFor = `dj-gain-${id}`;

    const gainSlider = document.createElement('input');
    gainSlider.type = 'range';
    gainSlider.id = `dj-gain-${id}`;
    gainSlider.min = '-40';
    gainSlider.max = '0';
    gainSlider.step = '1';

    const pendingNote = document.createElement('span');
    pendingNote.className = 'dj-pending-note';
    pendingNote.setAttribute('data-i18n', 'djPending');

    const caption = document.createElement('p');
    caption.className = 'dj-channel-caption';
    caption.setAttribute('data-i18n', `djCaption${id[0].toUpperCase()}${id.slice(1)}`);

    const gainValue = document.createElement('output');
    gainValue.className = 'dj-gain-value';
    gainValue.setAttribute('aria-hidden', 'true');

    const head = document.createElement('div');
    head.className = 'dj-strip-head';
    head.append(title, caption);
    const toggles = document.createElement('div');
    toggles.className = 'dj-strip-toggles';
    toggles.append(enableBtn, soloBtn);
    const gainBox = document.createElement('div');
    gainBox.className = 'dj-strip-gain';
    const gainLine = document.createElement('div');
    gainLine.className = 'dj-gain-line';
    gainLine.append(gainLabel, gainValue);
    gainBox.append(gainLine, gainSlider);

    row.setAttribute('data-channel', id);
    row.append(head, toggles, gainBox);
    if (PENDING_CHANNELS.includes(id)) {
      row.append(pendingNote);
      row.classList.add('is-pending');
      enableBtn.disabled = true;
      soloBtn.disabled = true;
      gainSlider.disabled = true;
    }
    if (id === 'temperature') row.append(tempUnitsNoteEl);
    if (id === 'rain') row.append(rainStatusEl);
    if (id === 'ice') row.append(iceStatusEl);
    channelsContainer.appendChild(row);
    channelEls[id] = { row, enableBtn, soloBtn, gainSlider, gainValue };

    if (REAL_CHANNELS.includes(id)) {
      enableBtn.addEventListener('click', () => {
        const current = store.get().dj.channels[id].enabled;
        store.set((s) => ({
          dj: { ...s.dj, channels: { ...s.dj.channels, [id]: { ...s.dj.channels[id], enabled: !current } } }
        }));
      });
      soloBtn.addEventListener('click', () => {
        const current = store.get().dj.channels[id].solo;
        store.set((s) => ({
          dj: { ...s.dj, channels: { ...s.dj.channels, [id]: { ...s.dj.channels[id], solo: !current } } }
        }));
      });
      gainSlider.addEventListener('input', (event) => {
        const gainDb = Number(event.target.value);
        store.set((s) => ({
          dj: { ...s.dj, channels: { ...s.dj.channels, [id]: { ...s.dj.channels[id], gainDb } } }
        }));
      });
    }
  }

  const seedRow = document.createElement('div');
  seedRow.className = 'form-row';
  const seedLabel = document.createElement('label');
  seedLabel.setAttribute('data-i18n', 'djSeedLabel');
  seedLabel.htmlFor = 'dj-seed';
  const seedInput = document.createElement('input');
  seedInput.type = 'text';
  seedInput.id = 'dj-seed';
  // MAX_SEED_LENGTH duplicado de sharing/preset.js a proposito (igual que
  // BPM_MIN/MAX en preset.js): evita acoplar dj-panel.js a ese modulo solo
  // por una constante.
  seedInput.maxLength = 64;
  seedRow.append(seedLabel, seedInput);
  // 'input' (no 'change'/blur): un borrador escrito pero todavia no
  // confirmado por blur se perdia si CUALQUIER otro store.set (p.ej. mover
  // el slider de BPM, o que llegue la lluvia) disparaba un render antes de
  // que el campo perdiera el foco, porque render() reescribe
  // seedInput.value = dj.seed (el valor VIEJO todavia en el store). Al
  // confirmar en cada tecla, dj.seed siempre refleja lo ya escrito.
  let seedFocused = false;
  seedInput.addEventListener('focus', () => {
    seedFocused = true;
  });
  seedInput.addEventListener('blur', () => {
    seedFocused = false;
  });
  seedInput.addEventListener('input', () => {
    store.set((s) => ({ dj: { ...s.dj, seed: seedInput.value } }));
  });

  const bpmRow = document.createElement('div');
  bpmRow.className = 'form-row';
  const bpmLabel = document.createElement('label');
  bpmLabel.setAttribute('data-i18n', 'djBpmLabel');
  bpmLabel.htmlFor = 'dj-bpm';
  const bpmSlider = document.createElement('input');
  bpmSlider.type = 'range';
  bpmSlider.id = 'dj-bpm';
  bpmSlider.min = String(BPM_MIN);
  bpmSlider.max = String(BPM_MAX);
  bpmSlider.step = '1';
  bpmRow.append(bpmLabel, bpmSlider);
  bpmSlider.addEventListener('input', () => {
    store.set((s) => ({ dj: { ...s.dj, bpm: Number(bpmSlider.value) } }));
  });

  // Composicion finita (20 s): boton propio, nunca autoplay. El texto de
  // reglas explica los tres instrumentos y que dato suena de verdad.
  const compositionExplain = document.createElement('p');
  compositionExplain.id = 'dj-composition-explain';
  const compositionRules = document.createElement('p');
  compositionRules.id = 'dj-composition-rules';
  const compositionBtn = document.createElement('button');
  compositionBtn.type = 'button';
  compositionBtn.className = 'action-btn';
  compositionBtn.id = 'dj-composition-btn';
  const compositionStatusEl = document.createElement('p');
  compositionStatusEl.id = 'dj-composition-status';
  compositionStatusEl.setAttribute('role', 'status');
  const soundingEl = document.createElement('p');
  soundingEl.id = 'dj-sounding';
  const musicRangeEl = document.createElement('p');
  musicRangeEl.id = 'dj-music-range';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'action-btn';
  playBtn.id = 'dj-play-btn';

  // "Explorar hemisferios": botones nativos (Tab/Enter/Espacio funcionan
  // sin codigo adicional, ver accessibility/keyboard.js) que seleccionan
  // puntos reales con cobertura de hielo verificada, para poder oir el
  // canal de hielo sin depender del globo 3D ni de clics de mouse.
  const exploreHeading = document.createElement('h3');
  exploreHeading.setAttribute('data-i18n', 'djIceExploreTitle');
  const exploreList = document.createElement('ul');
  exploreList.id = 'dj-ice-explore-list';
  const exploreButtons = [];
  for (const point of ICE_EXPLORE_POINTS) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-btn';
    btn.setAttribute(
      'data-i18n',
      `djIceExplore${point.id[0].toUpperCase()}${point.id.slice(1)}`
    );
    btn.addEventListener('click', () => onExplorePoint?.(point.lat, point.lon));
    li.appendChild(btn);
    exploreList.appendChild(li);
    exploreButtons.push(btn);
  }

  const transport = document.createElement('div');
  transport.className = 'dj-transport';
  const transportButtons = document.createElement('div');
  transportButtons.className = 'dj-transport-buttons';
  transportButtons.append(playBtn, compositionBtn);
  const transportFields = document.createElement('div');
  transportFields.className = 'dj-transport-fields';
  transportFields.append(seedRow, bpmRow);
  transport.append(transportButtons, transportFields, compositionStatusEl);

  const rulesDetails = document.createElement('details');
  rulesDetails.className = 'dj-rules';
  const rulesSummary = document.createElement('summary');
  rulesSummary.setAttribute('data-i18n', 'djRulesSummary');
  rulesDetails.append(rulesSummary, compositionExplain, compositionRules);

  root.append(
    heading,
    intro,
    statusEl,
    transport,
    channelsContainer,
    soundingEl,
    musicRangeEl,
    rulesDetails,
    exploreHeading,
    exploreList
  );

  let mixer = null;
  let generation = 0;
  let lastFetchKey = null;
  let iceGeneration = 0;
  let lastIceFetchKey = null;
  let appliedSeed = null;
  // Pestana activa en el render ANTERIOR: permite detectar la transicion
  // "se SALIO de DJ" (ver invalidacion al salir, en render()).
  let wasOnDjTab = false;

  /**
   * Verifica, contra el estado REAL actual (store.get(), nunca el
   * capturado al programar la solicitud), que esta solicitud sigue
   * correspondiendo al punto+periodo+pestana vigentes. Se llama DOS veces
   * en cada fetch: antes de arrancar (el microtask puede ejecutarse varios
   * ticks despues de programarse, y el usuario puede haber cambiado de
   * punto/periodo/pestana varias veces mientras tanto) y despues de
   * esperar la respuesta de red (ademas del guard de generacion ya
   * existente, por robustez).
   */
  function isQueryStillCurrent(queryKey) {
    const s = store.get();
    if (s.activeTab !== 'dj') return false;
    if (!s.selectedPoint || !s.confirmedPeriod) return false;
    return pointPeriodKey(s.selectedPoint.lat, s.selectedPoint.lon, s.confirmedPeriod) === queryKey;
  }

  function ensureMixer() {
    if (mixer) return mixer;
    if (!audioEngine.isStarted()) return null;
    mixer = new DjMixer({
      ToneLib: audioEngine.Tone,
      bus: audioEngine.getBus(),
      // Semilla vacia (campo borrado por el usuario mientras escribe) nunca
      // se usa tal cual para el PRNG: cae al valor por defecto solo en el
      // punto de uso, nunca se fuerza de vuelta en el input (ver listener
      // 'input' arriba).
      seed: store.get().dj.seed || 'earth-jukebox',
      bpm: store.get().dj.bpm
    });
    return mixer;
  }

  playBtn.addEventListener('click', () => {
    if (!audioEngine.isStarted()) return; // requiere gesto previo de "Activar sonido" (bus global)
    store.set((s) => ({
      composition: { playing: false, ended: false },
      dj: { ...s.dj, playing: !s.dj.playing }
    }));
  });

  compositionBtn.addEventListener('click', () => {
    if (!audioEngine.isStarted()) return;
    store.set((s) => ({
      composition: { playing: !s.composition.playing, ended: false },
      dj: { ...s.dj, playing: false }
    }));
  });

  function onCompositionEnd() {
    store.set(() => ({ composition: { playing: false, ended: true } }));
  }

  /**
   * queryKey (punto+periodo exactos de ESTA solicitud, ver pointPeriodKey)
   * se guarda dentro de rainInfo para que render() pueda validar que el
   * resultado todavia corresponde al punto/periodo ACTUALES (no solo al
   * periodo: dos puntos distintos en el MISMO periodo tenian el mismo
   * "dj.rainInfo.period/monthly" y nada distinguia cual de los dos lo
   * produjo). Ver nota de reentrancia en render().
   */
  async function fetchRainFor(lat, lon, period, queryKey) {
    // Guard de microtask (ver isQueryStillCurrent arriba): si para cuando
    // esto se ejecuta el usuario ya cambio de punto/periodo otra vez, o
    // salio de la pestana DJ, no se toca el store en absoluto.
    if (!isQueryStillCurrent(queryKey)) return;
    const myGeneration = ++generation;
    store.set((s) => ({ dj: { ...s.dj, rainInfo: null, rainError: null } }));
    const year = yearFromPeriod(period);
    const result = await powerRepository.getMonthlyForPoint(lat, lon, { year });
    if (myGeneration !== generation) return; // punto/periodo ya cambio: se descarta esta respuesta
    if (!isQueryStillCurrent(queryKey)) return; // repetido tras el await, por robustez
    if (!result.ok) {
      store.set((s) => ({ dj: { ...s.dj, rainInfo: null, rainError: { queryKey, error: result.error } } }));
      return;
    }
    store.set((s) => {
      // Si un preset abierto esperaba una version de POWER concreta
      // (dataVersions.power) y la lluvia resuelta ahora trae otra, se
      // informa explicitamente: los datos de NASA POWER pueden revisarse
      // entre consultas (ver docs/power-data.md), nunca se promete una
      // reproduccion exacta sin advertirlo.
      const versionMismatch = Boolean(
        s.dj.expectedDataVersion && result.dataVersion && result.dataVersion !== s.dj.expectedDataVersion
      );
      return {
        dj: {
          ...s.dj,
          rainError: null,
          rainInfo: {
            queryKey,
            source: result.source,
            name: result.name ?? null,
            dataVersion: result.dataVersion,
            units: result.units,
            periodStart: result.periodStart,
            periodEnd: result.periodEnd,
            monthly: result.monthly,
            year,
            versionMismatch
          }
        }
      };
    });
  }

  /**
   * Resuelve el hielo (NOAA/NSIDC G02135) para (lat, lon, periodo). Mismo
   * patron de cancelacion/guard que fetchRainFor. "Fuera de serie" (un
   * periodo sin datos 2023 reales) ya NO se maneja aqui: render() lo
   * deriva sincronicamente de `iceRepository.hasPeriod(confirmedPeriod)` y
   * ni siquiera programa esta funcion para esos periodos (ver render()),
   * asi que nunca puede quedar una bandera vieja de "fuera de serie" de un
   * periodo distinto al actual. `queryKey`: ver fetchRainFor arriba.
   */
  async function fetchIceFor(lat, lon, period, queryKey) {
    if (!iceRepository) return;
    if (!isQueryStillCurrent(queryKey)) return;
    const myGeneration = ++iceGeneration;
    // Defensivo: aunque render() ya filtra periodos fuera de serie antes
    // de llegar aqui, se revalida (sin escribir nada al store) por si la
    // serie disponible cambiara entre programar y ejecutar este microtask.
    if (!iceRepository.hasPeriod(period)) return;
    store.set((s) => ({ dj: { ...s.dj, iceInfo: null, iceError: null } }));
    const result = await iceRepository.getCellForPoint(lat, lon, period);
    if (myGeneration !== iceGeneration) return; // punto/periodo ya cambio: se descarta esta respuesta
    if (!isQueryStillCurrent(queryKey)) return; // repetido tras el await, por robustez
    if (!result.ok) {
      if (result.reason === 'stale' || result.reason === 'out-of-series') return;
      store.set((s) => ({ dj: { ...s.dj, iceInfo: null, iceError: { queryKey, error: result.detail ?? result.reason } } }));
      return;
    }
    store.set((s) => {
      const versionMismatch = Boolean(
        s.dj.expectedIceVersion && result.dataset.version_hash && result.dataset.version_hash !== s.dj.expectedIceVersion
      );
      return {
        dj: {
          ...s.dj,
          iceError: null,
          iceInfo: {
            queryKey,
            period: result.period,
            value: result.cell.value,
            coverage: result.dataset.coverage?.[result.cell.index] ?? null,
            versionHash: result.dataset.version_hash,
            dataset: result.dataset.dataset,
            versionMismatch
          }
        }
      };
    });
  }

  function render(state) {
    const { lang, dj, selectedPoint, confirmedPeriod, cell, activeTab, audio } = state;
    const composition = state.composition ?? { playing: false, ended: false };

    // Invalidacion al SALIR de la pestana DJ: cualquier solicitud de
    // lluvia/hielo todavia en vuelo queda invalidada (bump de generacion,
    // redundante con isQueryStillCurrent pero defensivo) y las claves de
    // "ultimo fetch" se resetean a null. Sin este reset, volver a DJ con
    // el MISMO punto+periodo de antes nunca disparaba un fetch nuevo
    // (la clave ya coincidia con lastFetchKey/lastIceFetchKey), aunque la
    // solicitud original jamas hubiera escrito nada al store por haber
    // sido abortada por el guard de pestana al salir.
    if (wasOnDjTab && activeTab !== 'dj') {
      generation += 1;
      iceGeneration += 1;
      lastFetchKey = null;
      lastIceFetchKey = null;
    }
    wasOnDjTab = activeTab === 'dj';

    for (const id of [...REAL_CHANNELS, ...PENDING_CHANNELS]) {
      const ch = dj.channels[id];
      const els = channelEls[id];
      if (REAL_CHANNELS.includes(id)) {
        const channelName = t(lang, `djChannel${id[0].toUpperCase()}${id.slice(1)}`);
        els.enableBtn.textContent = t(lang, 'djChannelEnable');
        // aria-label UNICO por canal (incluye el nombre del canal): con el
        // mismo texto generico en los 4 controles, un lector de pantalla no
        // puede distinguir "Activar canal" de temperatura del de lluvia.
        els.enableBtn.setAttribute('aria-label', `${t(lang, 'djChannelEnable')} – ${channelName}`);
        els.enableBtn.setAttribute('aria-pressed', String(ch.enabled));
        els.soloBtn.setAttribute('aria-label', `${t(lang, 'djChannelSolo')} – ${channelName}`);
        els.soloBtn.setAttribute('aria-pressed', String(ch.solo));
        els.gainSlider.value = String(ch.gainDb);
        els.gainValue.textContent = `${ch.gainDb} dB`;
        els.gainSlider.setAttribute('aria-label', `${t(lang, 'djChannelGain')} – ${channelName}`);
        if (mixer) mixer.setChannel(id, { enabled: ch.enabled, gainDb: ch.gainDb, solo: ch.solo });
      }
    }

    // Nunca se pisa lo que el usuario esta escribiendo: mientras el campo
    // tiene el foco, su valor en el DOM es la fuente de verdad (ya se
    // confirmo a store en cada tecla via 'input'); solo se sincroniza desde
    // el estado cuando NO tiene el foco (p.ej. al restaurar un preset).
    if (!seedFocused) seedInput.value = dj.seed;
    bpmSlider.value = String(dj.bpm);

    playBtn.textContent = t(lang, dj.playing ? 'djStop' : 'djPlay');
    playBtn.setAttribute('aria-pressed', String(dj.playing));
    playBtn.disabled = !audioEngine.isStarted();

    if (!audioEngine.isStarted()) {
      statusEl.textContent = t(lang, 'audioActivate');
    } else if (!selectedPoint) {
      statusEl.textContent = t(lang, 'djNoPoint');
    } else {
      statusEl.textContent = '';
    }

    // Hallazgo real corregido (ver docs/dj-data-sources.md / notas de
    // revision): fetchRainFor/fetchIceFor hacian su primer store.set
    // (limpiar rainInfo/iceInfo) de forma SINCRONA, dentro de ESTE MISMO
    // render(): como store.set notifica a los subscriptores de inmediato
    // (ver state/store.js), eso REENTRABA render() de forma anidada ANTES
    // de que este render() exterior terminara de ejecutarse. El render()
    // exterior seguia usando sus variables locales (`dj`, `lastFetchKey`
    // ya actualizado por el anidado, etc.) capturadas al principio de ESTA
    // llamada, pudiendo re-escribir en el mezclador/UI un estado mas viejo
    // que el que el render anidado ya habia corregido. Se corrige en dos
    // frentes independientes:
    //  1. El fetch real (y su store.set) se programa con queueMicrotask:
    //     para cuando se ejecuta, este render() YA TERMINO por completo,
    //     asi que ya no hay ningun render "exterior" que pueda pisarlo.
    //  2. rainInfo/iceInfo guardan su propio `queryKey` (punto+periodo
    //     EXACTOS de la solicitud que los produjo): aunque llegara a
    //     sobrevivir una lectura con datos de otro punto/periodo, nunca se
    //     usa para el mezclador/UI a menos que coincida con el punto+
    //     periodo ACTUALES (antes solo se comparaba el periodo, no las
    //     coordenadas: dos puntos distintos en el mismo mes compartian
    //     "periodo" y nada distinguia a cual pertenecia el dato).
    const rainKey = selectedPoint && confirmedPeriod ? pointPeriodKey(selectedPoint.lat, selectedPoint.lon, confirmedPeriod) : null;
    const rainInfoCurrent = dj.rainInfo && dj.rainInfo.queryKey === rainKey ? dj.rainInfo : null;
    const rainErrorCurrent = dj.rainError && dj.rainError.queryKey === rainKey ? dj.rainError : null;
    let rainForMixer = rainInfoCurrent;
    if (rainKey && rainKey !== lastFetchKey && activeTab === 'dj') {
      lastFetchKey = rainKey;
      rainForMixer = null;
      queueMicrotask(() => fetchRainFor(selectedPoint.lat, selectedPoint.lon, confirmedPeriod, rainKey));
    }

    // "Fuera de serie" se deriva SINCRONICAMENTE aqui (sin red, siempre
    // fresco para el periodo ACTUAL): nunca se programa fetchIceFor para
    // un periodo sin serie 2023 real, asi que nunca puede quedar una
    // bandera vieja de otro periodo confundida con el actual.
    const iceOutOfSeriesNow = Boolean(iceRepository && confirmedPeriod && !iceRepository.hasPeriod(confirmedPeriod));
    const iceKey = selectedPoint && confirmedPeriod ? pointPeriodKey(selectedPoint.lat, selectedPoint.lon, confirmedPeriod) : null;
    const iceInfoCurrent = !iceOutOfSeriesNow && dj.iceInfo && dj.iceInfo.queryKey === iceKey ? dj.iceInfo : null;
    const iceErrorCurrent = !iceOutOfSeriesNow && dj.iceError && dj.iceError.queryKey === iceKey ? dj.iceError : null;
    let iceValueForMixer = iceInfoCurrent ? iceInfoCurrent.value : null;
    if (iceKey && !iceOutOfSeriesNow && iceKey !== lastIceFetchKey && activeTab === 'dj') {
      lastIceFetchKey = iceKey;
      iceValueForMixer = null;
      queueMicrotask(() => fetchIceFor(selectedPoint.lat, selectedPoint.lon, confirmedPeriod, iceKey));
    }

    // Arranca/detiene el mezclador segun dj.playing, SIEMPRE a traves del
    // bus del AudioEngine ya iniciado (mismo gesto/mute/volumen/limiter);
    // nunca crea un segundo camino de audio. Reentrante: no acumula loops.
    const wantedMode =
      audioEngine.isStarted() && activeTab === 'dj' && !audio.muted
        ? composition.playing
          ? 'composition'
          : dj.playing
            ? 'dj'
            : null
        : null;
    if (wantedMode) {
      const m = ensureMixer();
      if (m) {
        // setSeed() reinicia el PRNG de lluvia (ver audio/mixer.js): SOLO se
        // llama cuando la semilla realmente cambio, nunca en cada render
        // (volumen/mute/periodo/otros store.set no deben reiniciar la
        // secuencia de una mezcla ya en marcha).
        const effectiveSeed = dj.seed || 'earth-jukebox';
        if (effectiveSeed !== appliedSeed) {
          m.setSeed(effectiveSeed);
          appliedSeed = effectiveSeed;
        }
        m.setBpm(dj.bpm);
        m.updateData({
          temperature: cell?.value ?? null,
          rain: rainForMixer ? rainForMixer.monthly?.[confirmedPeriod] ?? null : null,
          ice: iceValueForMixer
        });
        m.start({ mode: wantedMode, onEnd: wantedMode === 'composition' ? onCompositionEnd : null });
      }
    } else if (mixer) {
      mixer.stop();
    }
    // Salir de la pestana DJ detiene la mezcla y la composicion.
    if (activeTab !== 'dj' && (dj.playing || composition.playing)) {
      store.set((s) => ({ composition: { playing: false, ended: false }, dj: { ...s.dj, playing: false } }));
    }
    // Mute: corta todo (arriba, wantedMode = null) y cancela la composicion
    // finita; el DJ continuo conserva su preferencia.
    if (audio.muted && composition.playing) {
      store.set(() => ({ composition: { playing: false, ended: false } }));
    }

    compositionExplain.textContent = t(lang, 'compositionExplain', { seconds: String(COMPOSITION_SECONDS) });
    compositionRules.textContent = t(lang, 'compositionRules');
    compositionBtn.textContent = t(lang, composition.playing ? 'compositionStop' : 'compositionPlay', {
      seconds: String(COMPOSITION_SECONDS)
    });
    compositionBtn.setAttribute('aria-pressed', String(composition.playing));
    compositionBtn.disabled = !audioEngine.isStarted();
    compositionStatusEl.textContent = composition.playing
      ? t(lang, 'compositionStatusPlaying', { seconds: String(COMPOSITION_SECONDS) })
      : composition.ended
        ? t(lang, 'compositionStatusEnded')
        : '';

    const temperatureValue = typeof cell?.value === 'number' ? cell.value : null;
    const rainMonth = rainForMixer ? rainForMixer.monthly?.[confirmedPeriod] ?? null : null;
    const sounding = describeSounding({ temperature: temperatureValue, rain: rainMonth, ice: iceValueForMixer });
    const lines = [];
    if (sounding.piano) {
      lines.push(t(lang, 'soundingPiano', { value: temperatureValue.toFixed(2), register: String(sounding.piano.register + 1) }));
    }
    if (sounding.drops) lines.push(t(lang, 'soundingDrops', { value: rainMonth.toFixed(2) }));
    if (sounding.ice) {
      lines.push(t(lang, sounding.ice.silent ? 'soundingIceZero' : 'soundingIce', { percent: (iceValueForMixer * 100).toFixed(1) }));
    }
    soundingEl.textContent = selectedPoint
      ? lines.length > 0
        ? t(lang, 'soundingNow', { list: lines.join(' ') })
        : t(lang, 'soundingNothing')
      : '';
    const musicLines = [t(lang, 'musicRangeNote', { min: MUSIC_ANOMALY_RANGE.min, max: MUSIC_ANOMALY_RANGE.max })];
    if (sounding.piano?.saturated) {
      musicLines.push(t(lang, 'musicSaturated', { value: temperatureValue.toFixed(2) }));
    }
    musicRangeEl.textContent = musicLines.join(' ');

    // rainInfoCurrent (gateado por queryKey, ver arriba): un rainInfo que
    // ya no corresponde al punto/periodo actuales se trata como "todavia
    // sin dato" (loading), nunca se muestra el del punto anterior.
    if (rainErrorCurrent) {
      rainStatusEl.textContent = t(lang, 'djRainError');
    } else if (rainInfoCurrent) {
      const monthValue = rainInfoCurrent.monthly?.[confirmedPeriod];
      const hasValue = typeof monthValue === 'number';
      const { saturated } = hasValue ? rainToDensity(monthValue) : { saturated: false };
      const sourceLine =
        rainInfoCurrent.source === 'local'
          ? t(lang, 'djRainLocal', {
              name: rainInfoCurrent.name,
              start: rainInfoCurrent.periodStart,
              end: rainInfoCurrent.periodEnd
            })
          : t(lang, 'djRainApi', { year: rainInfoCurrent.year });
      // Muestra AMBOS valores confirmados (punto+periodo), unidad de tasa
      // diaria media mensual y procedencia MERRA2/resolucion, no solo la
      // fuente/cobertura: el periodo/valor concreto que realmente esta
      // sonando en el canal de lluvia.
      const valueLine = hasValue
        ? t(lang, 'djRainValue', { period: confirmedPeriod, value: monthValue.toFixed(2), units: rainInfoCurrent.units })
        : t(lang, 'djRainValueMissing', { period: confirmedPeriod });
      const parts = [sourceLine, valueLine, t(lang, 'djUnitsNote')];
      if (saturated) parts.push(t(lang, 'djRainSaturated'));
      if (rainInfoCurrent.versionMismatch) parts.push(t(lang, 'djDataVersionMismatch'));
      rainStatusEl.textContent = parts.join(' ');
    } else if (selectedPoint && activeTab === 'dj') {
      rainStatusEl.textContent = t(lang, 'djRainLoading');
    } else {
      rainStatusEl.textContent = '';
    }

    // ES/EN: concentracion %, cobertura (pixeles de 25km validos que
    // promediaron esta celda) y fuente real (NOAA/NSIDC, no "NASA puro",
    // ver docs/pending-data-research.md) en una etiqueta accesible (role
    // status, se anuncia por lector de pantalla al cambiar). iceInfoCurrent
    // (gateado por queryKey): igual que rainInfoCurrent arriba.
    if (iceErrorCurrent) {
      iceStatusEl.textContent = t(lang, 'djIceError');
    } else if (iceOutOfSeriesNow) {
      iceStatusEl.textContent = t(lang, 'djIceOutOfSeries', { period: confirmedPeriod ?? '' });
    } else if (iceInfoCurrent) {
      const hasValue = typeof iceInfoCurrent.value === 'number';
      const valueLine = hasValue
        ? t(lang, 'djIceValue', { period: iceInfoCurrent.period, percent: (iceInfoCurrent.value * 100).toFixed(1) })
        : t(lang, 'djIceValueMissing', { period: iceInfoCurrent.period });
      const coverageLine = t(lang, 'djIceCoverage', { count: iceInfoCurrent.coverage ?? 0 });
      const parts = [valueLine, coverageLine, t(lang, 'djIceSource'), t(lang, 'djIceThresholdNote')];
      if (iceInfoCurrent.versionMismatch) parts.push(t(lang, 'djDataVersionMismatch'));
      iceStatusEl.textContent = parts.join(' ');
    } else if (selectedPoint && activeTab === 'dj') {
      iceStatusEl.textContent = t(lang, 'djIceLoading');
    } else {
      iceStatusEl.textContent = '';
    }
  }

  return { render };
}
