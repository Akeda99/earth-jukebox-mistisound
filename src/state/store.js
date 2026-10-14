/**
 * Store minimo de pub/sub. Se mantiene "requestedPeriod" (lo que el
 * usuario pidio, p.ej. moviendo la barra de tiempo) separado de
 * "confirmedPeriod" (el ultimo dataset que realmente termino de cargar y
 * validar), para poder distinguir en la UI cuando hay una solicitud en
 * vuelo distinta de lo confirmado.
 */
export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { get, set, subscribe };
}

export function createInitialState({ lang }) {
  return {
    lang,
    requestedPeriod: null,
    confirmedPeriod: null,
    periodError: null, // periodo cuya carga fallo (para UI de reintento)
    overlayError: null, // periodo cuyo overlay visual fallo (dataset si es valido)
    dataset: null,
    selectedPoint: null, // { lat, lon }
    cell: null, // resultado de findNearestCell para selectedPoint + dataset
    audio: { started: false, muted: false, volumeDb: -12 },
    playback: { playing: false },
    composition: { playing: false, ended: false },
    // { a, b, pointKey }: a/b = { period, value }; pointKey identifica la
    // celda (latIdx:lonIdx) a la que pertenecen, para invalidar la
    // comparacion si el usuario selecciona otro lugar antes de completarla.
    compare: { a: null, b: null, pointKey: null },
    globeError: null,
    imageryError: false,
    activeTab: 'history', // 'history' | 'explore' | 'peru' | 'accessible' | 'dj'
    narration: { speaking: false, lang: null },
    // narrationAuto: opt-in, por defecto OFF (no competir con lector de
    // pantalla). Cuando esta activo, se anuncia por voz el estado
    // confirmado tras una consulta/cambio de periodo, con debounce.
    narrationAuto: false,
    // Estado del DJ (fase 5, hielo real desde fase 9): canales reales
    // disponibles (temperatura, lluvia, hielo) + incendios (deshabilitado
    // sin datos reales), semilla reproducible y transporte.
    dj: createDjState(),
    // Tu historia con la Tierra (ver history/history-controller.js).
    history: createHistoryState()
  };
}

export function createHistoryState() {
  return {
    status: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
    error: null,
    result: null,
    playing: null, // null | { epoch: 'a'|'b', auto: boolean, phase: 'loading'|'music'|'gap' }
    lastPlay: null, // 'a' | 'b' | 'auto'
    ended: false,
    playError: null, // null | 'epoch' | 'start': por que no arranco la escucha
    voice: false // anuncio por voz de cada epoca: opt-in, desactivado por defecto
  };
}


export function createDjState() {
  return {
    seed: 'earth-jukebox',
    bpm: 72,
    playing: false,
    channels: {
      temperature: { enabled: true, gainDb: -6, solo: false, available: true },
      rain: { enabled: true, gainDb: -6, solo: false, available: true },
      ice: { enabled: true, gainDb: -6, solo: false, available: true },
      fires: { enabled: false, gainDb: -6, solo: false, available: false }
    },
    // Info de la ultima resolucion de lluvia (local/API) para el punto
    // seleccionado: null mientras no se ha resuelto nada. Permite mostrar
    // fuente/unidades/dataVersion y rellenar dataVersions.power en el
    // preset compartido (ver sharing/preset.js), sin confundir la version
    // del ESQUEMA del preset con la version del PAQUETE DE DATOS.
    rainInfo: null,
    // null, o { queryKey, error } (ver pointPeriodKey en ui/dj-panel.js):
    // queryKey identifica el punto+periodo EXACTOS que produjeron este
    // error, para que un error del punto anterior nunca se muestre como
    // si fuera del punto actual mientras la solicitud nueva esta en vuelo.
    rainError: null,
    // Version de POWER esperada por un preset recien aplicado (si la trae),
    // para poder avisar explicitamente si la lluvia resuelta para este punto
    // llega con una version distinta (ver sharing/preset.js: dataVersions).
    // null = sin preset aplicado todavia o preset sin dataVersions.power.
    expectedDataVersion: null,
    // Info de la ultima resolucion de hielo (NOAA/NSIDC G02135) para el
    // punto+periodo seleccionado: null mientras no se ha resuelto nada.
    // "Fuera de serie" (periodo sin datos 2023 reales) ya NO se guarda
    // aqui: dj-panel.js lo deriva en cada render directamente de
    // `iceRepository.hasPeriod(confirmedPeriod)` (sincrono, sin red,
    // siempre fresco), para que nunca pueda quedar una bandera vieja
    // mostrando "fuera de serie" de un periodo distinto al actual. iceError
    // (fallo real de red/validacion) SI se guarda, como { queryKey, error }
    // (ver rainError arriba).
    iceInfo: null,
    iceError: null,
    // Version de hielo (version_hash de G02135) esperada por un preset
    // recien aplicado (dataVersions.seaIce), para avisar si el hielo
    // resuelto para este punto+periodo llega con otra version.
    expectedIceVersion: null
  };
}
