# Criterios de aceptacion: verificado vs pendiente

Este documento distingue lo que se ejecuto y se vio pasar realmente de lo
que queda pendiente de verificacion manual (lector de pantalla real,
telefono fisico). Estado al dia de esta entrega (fase 9-12: canal de
hielo real, correccion de audio offline, auditoria de accesibilidad).

## Verificado (automatizado, `npm test` + `npm run build`)

- `npm test`: **181 pruebas, 16 archivos**, todas en verde (`vitest run`).
  Incluye temperatura/lluvia/hielo (3 canales DJ reales: GISTEMP, NASA
  POWER, NOAA/NSIDC G02135), reentrancia del panel DJ corregida con
  pruebas que usan `store.subscribe(panel.render)` real (no simulan la
  logica), `IceRepository` (cache LRU, timeout+abort, coalescencia,
  bounded cancel guard), `preset.test.js` (esquema v2 con hielo), grid/
  validate/power-repository/mixer/narration/action-coordinator/gistemp-
  export/gibs-tiling.
- `npm run build`: compila sin errores. Cesium esta en un **chunk
  separado** (`cesium-*.js`, ~4.2 MB, vs. `index-*.js` ~420 KB): logrado
  via `build.rolldownOptions.output.codeSplitting` (Vite 8 usa Rolldown,
  no Rollup; `rollupOptions.output.manualChunks` NO funciona en este
  bundler, ver `vite.config.js`).

## Verificado con audio REAL (Tone.Offline, no mock): `scripts/verify_audio_offline.py`

**40/40 verificaciones OK** (corrida del cierre 13), contra los modulos de PRODUCCION
(`AudioEngine`/`DjMixer`), renderizando audio real con
`OfflineAudioContext` dentro de Chromium headless real (Python
Playwright). Ver `docs/audio-verification.md` para el detalle completo,
incluyendo DOS hallazgos reales sobre `Tone.Offline()` (el contexto global
se restaura antes de que el render termine, afectando `Transport`/
`Destination` Y `now`/`Time`) y su correccion.

- Temperatura: pico de FFT (`numpy.fft`, independiente, banda 80-2500Hz)
  coincide con la nota pentatonica esperada (recalculada
  independientemente) para 5 anomalías, monotonia estricta.
- Mute real: `DjMixer` continuo sobre un `Transport` REALMENTE arrancado;
  confirma que el callback de mute se ejecuta, `isMuted()===true`, un
  control sin mutear SI suena en la misma ventana, y RMS/pico tras la
  rampa son `<=1e-7` (epsilon estricto). La version anterior de este test
  era un FALSO POSITIVO (nunca arrancaba el Transport, el callback de
  mute nunca se ejecutaba): corregido.
- Hielo: "fade" con la fraccion ESTRICTAMENTE creciente (.25<.5<.75<1);
  fraccion 0.0 real = silencio real (no error).
- Lluvia: mas mm/day = mas "hits" ritmicos; el intervalo fundamental de
  onsets coincide con `60/bpm/4` para BPM 48/72/96 (0.310/0.210/0.155 s) y
  un control negativo (adapter `Time` a BPM 120) FALLA esa metrica
  (0.125 s, 0/35 coinciden). Bug real corregido antes: BPM 120 por defecto.
- `stop()` no deja ningun pulso fantasma sonando tras detener la mezcla.
- Demo WAV (`outputs/earth-jukebox-demo.wav`, 2 canales, 8s): datos
  REALES de UN punto/mes concreto (Artico 75.19N/-133.67W, diciembre
  2023: hielo 0.9861/cobertura 21px NOAA/NSIDC G02135, lluvia 0.33mm/day
  NASA POWER snapshot publico en `tests/fixtures/demo-point-evidence/` con sidecar URL/fecha/SHA256, temperatura 7.82K GISTEMP que satura el rango -5..5 de la nota mas aguda); parametros derivados de los JSON, no escritos a mano.

Harness permanente y reproducible: `tests/browser/audio-harness.{html,js}`
(importa `src/` real), dependencias Python opcionales en
`scripts/requirements-browser-tests.txt`.

## Verificado con accesibilidad REAL (axe-core + Python Playwright): `scripts/verify_accessibility.py`

Auditoria ES/EN en 360x800 (movil) y 1280x720 (escritorio) con axe-core
real (obtenido via `npm pack axe-core`, registro oficial, NO agregado a
`package.json`/dependencias de runtime) + navegacion por teclado real
(foco directo + Tab/Enter/Espacio, sin atajos propios, igual contrato que
`accessibility/keyboard.js`). Hallazgo real corregido: `<nav
id="section-tabs">` tenia `role="group"` invalido sobre un elemento `nav`
(axe `aria-allowed-role`); se quito, dejando el rol implicito
`navigation` (valido). Ver `docs/accessibility-review.md` para el
resultado completo de la corrida mas reciente.

Verificado por separado, SIN necesidad de repetirlo (la logica de
compartir/POWER no cambio desde entonces): enlace de preset v2 con los 3
canales reales (temperatura/lluvia/hielo), `dataVersions.seaIce` con aviso
de version distinta al abrir en otra pestana, NASA POWER en vivo
resolviendo un punto fuera de Peru (Artico, 0.33 mm/day), sin autoplay.

## Pendiente de verificacion manual (no ejecutado, honesto)

- **Lectores de pantalla reales** (NVDA/JAWS/VoiceOver/TalkBack): toda la
  verificacion de accesibilidad es DOM/ARIA/contraste/foco via axe-core +
  Playwright, no escucha real de un lector de pantalla.
- **Voces de `SpeechSynthesis` reales**: Chromium headless en este
  entorno expone la API pero devuelve **0 voces** (`getVoices().length
  === 0`), verificado por ejecucion real (ver
  `docs/pending-validation.md`). Windows SI tiene 3 voces en ingles
  instaladas a nivel de sistema (OneCore: David, Mark, Zira; NINGUNA en
  espanol), confirmadas por lectura de registro de solo lectura — pero
  Chromium headless no las expone. Ninguna de las dos rutas prueba la
  experiencia real con una voz sonando.
- **Dispositivos tactiles/telefono fisico real**: los objetivos de 44px y
  el layout responsivo se verificaron con viewports EMULADOS en Chromium
  headless, no en hardware real.
- **Escucha humana del audio**: toda la verificacion de audio es numerica
  (RMS/FFT/onsets), nunca "sono bien" subjetivo.
- **Incendios (NASA FIRMS)**: sigue bloqueado por requerir una cuenta
  personal de NASA Earthdata/FIRMS MAP_KEY que esta tarea no sortea ni
  solicita (ver `docs/dj-data-sources.md`,
  `docs/pending-data-research.md`). El canal permanece deshabilitado en
  la UI, sin datos simulados.
- **NASA POWER no tiene version congelada para consultas en vivo**: a
  diferencia de los 3 puntos locales de Peru (que SI tienen
  `data_version` fijo), cualquier punto fuera de Peru consulta la API en
  vivo cada vez; un valor documentado hoy (p.ej. 0.33 mm/day para el demo)
  podria cambiar en una consulta futura si NASA revisa el dato. Esto se
  documenta explicitamente en los presets compartidos (`dataVersions.power:
  null` para consultas en vivo), nunca se presenta como "congelado".

## Tarea 14: mejora musical (composicion de 20 s)

Resultados medidos en esta corrida (Chromium headless, sin escucha humana):

- `npm test`: 17 archivos / 212 pruebas OK; `npm run build` OK.
- `verify_audio_offline.py`: 71/71 (ver `docs/audio-verification.md`).
- `verify_accessibility.py`: 97/97 (axe sin violaciones en las pestanas,
  incluida DJ con la composicion; teclado, sin autoplay al recargar un
  enlace). No hay una prueba de teclado dedicada al boton de composicion:
  lo cubre axe + las pruebas unitarias del panel.
- Rendimiento: `requestRenderMode: true` + `maximumRenderTimeChange: Infinity`
  (antes ~14 frames/5 s en reposo con render continuo; despues 0 frames en
  reposo tras interactuar; arrastre 15, zoom 5, flyTo 17, cambio de fecha 5 y
  marcador 2 frames, con la camara/capas/entidades realmente cambiadas).
  Evidencia: `work/render-load-run14.txt`. Durante la carga inicial en
  headless el globo tarda en asentarse (>40 s); no se resolvio con flags
  globales de GPU/OS.
- Preset v3 con bloque `music`; v2 se abre sin autoplay y con aviso;
  versiones desconocidas dan error.

Pendiente / no verificado: escucha humana, NVDA/lectores de pantalla reales,
telefono fisico. Incendios sigue deshabilitado. Los TargetClosed 93/96 de
rondas previas no se reclasifican como PASS.

### Tarea 14b: ciclo de vida de cortes (latch)

- `DjMixer` mantiene un latch por canal: NULL o `stop()` dejan la ganancia en
  0 aunque `dj-panel.render` vuelva a llamar `setChannel` con la misma
  config; solo un dato nuevo aplicado en limite de compas o un `start()` lo
  rearman. `stop()` es idempotente y corta tambien la cola tras el fin
  natural; `start()` reconstruye los instrumentos (sin voces de la sesion
  anterior).
- Fin natural: la cola del pad queda acotada (release 2 s, ~20.0-22.3 s; RMS
  4.3e-4 en 20.6-22.0 s, 0 a partir de 23 s) hasta que se pulsa Stop.
- Regresion real en Tone.Offline (pad continuo como control, RMS 0.00908):
  NULL->setChannel+rerender, stop->setChannel+rerender y fin->Stop->setChannel
  dan RMS <= 1e-7 tras la rampa de 30 ms. Verificado que sin el latch esas
  pruebas FALLAN (RMS 4.9e-4, 4.8e-4 y 9.3e-5).
- Prueba de integracion de panel con `store.subscribe` real: A suena, B
  pendiente + rerenders no reabren el pad ni reinyectan A.
- Teclado: `scripts/verify_composition_keyboard.py` 6/6 (Enter inicia/detiene,
  sin autoplay). No se repitio la auditoria completa de 97 (UI sin cambios).

## Tarea 15: Tu historia con la Tierra

**Verificado (automatizado).** `npm test`: 244 pruebas JS (212 previas + 32
nuevas en `tests/history.test.js` y `tests/gistemp-history-epochs.test.js`:
validacion de fechas/lugar, NULL vs 0, diferencia en °C (no 273 ni %), versiones
de fuente, doble `fetchPeriod` coalescido, respuesta tardia, cancelar al salir
de la pestana/silenciar/Detener, mismas semillas A/B y orden, enlace de
historia sin dia exacto ni nombre, enlaces viejos). `pytest
tests/dj-data/test_prepare_geonames.py`: 3 pruebas del catalogo.
`npm run build` OK.

**Verificado en navegador real** (`scripts/verify_history.py`, Chromium +
axe-core, 360x800 y 1280x720): Iquitos + 1990-01 contra 2026-08 con valores
leidos por separado de los JSON (+0.18 y +2.97, diferencia +2.79 °C); errores
de formulario; sin autoplay; escuchar antes/despues, secuencia automatica,
Detener, mute y salir de la pestana cortan el audio; ES/EN; Tab natural; enlace
compartido restaurado sin audio; celda NULL ("Sin dato"); enlace directo a DJ
sin pasar por Historia; axe sin violaciones en Historia (vacia, con resultado
y en EN). `scripts/verify_accessibility.py` ahora recorre 5 pestanas.

**Pendiente (no ejecutado, honesto).** Escucha humana real de las dos
epocas, lector de pantalla real (NVDA/VoiceOver) y telefono fisico. Los datos
son anomalias mensuales de una celda de 2° suavizada a 1200 km respecto a
1951-1980: no son el clima exacto del dia ni la temperatura absoluta, y la
comparacion no demuestra tendencia ni causa. Incendios (NASA FIRMS) sigue
pendiente de autenticacion; no se invento.

### Tarea 15b: cierre de revision (sincronia y cancelacion)

- Escuchar una epoca ahora espera a que el globo/linea de tiempo confirmen el
  periodo (`onShowEpoch` devuelve promesa) antes de musica y voz; mientras
  tanto la interfaz muestra "Mostrando esa epoca…". Si falla, no suena nada y
  se avisa en el idioma activo. Detener, silenciar, salir de la pestana o una
  escucha nueva antes de que resuelva impiden cualquier arranque tardio.
- Cambiar ciudad/coordenadas/fecha, o tocar el globo o la linea de tiempo,
  cancela la consulta, el audio y el resultado previos (se conserva el
  borrador del formulario). La propia historia no se autocancela.
- Pruebas: 254 unitarias, build, `verify_history.py` 74/74 y
  `verify_composition_keyboard.py` 6/6 (Chromium automatizado). No se repitio
  la bateria de audio ni la de axe completa: el mezclador y la estructura no
  cambiaron. Sin verificacion con NVDA, oido humano ni telefono fisico.

### Tarea 15c: caso de respuesta tardia (cierre de la prueba pendiente de 15b)

- Escenario Playwright `verify_history.py --scenario late-response`: enlace
  `history` con A=1990-01 retenido con `page.route`, clic real en el canvas
  del globo (punto B, sin salir de la pestana Historia), luego se libera la
  respuesta A. Comprueba en el DOM (`#acc-description` mientras no hay
  dataset, luego `#field-coords` de point-info) que el punto sigue en B, que
  el resultado viejo de Historia no queda activo y que no hay audio. Usa el
  `main.js` de produccion (coordinador real), sin inyectar estado.
- Resultado: 8/8 verificaciones OK en Chromium automatizado. Comprobacion de
  mutacion: sin `historyController?.cancelQuery()` en `selectPoint` el
  escenario falla (6/8: el punto vuelve a Iquitos y reaparece el resultado
  viejo); con el codigo restaurado pasa. No se corrio de nuevo toda la
  bateria (74/105): el codigo de la aplicacion no cambio en 15c. Sin NVDA,
  oido humano ni telefono fisico.

### Tarea 15d: ajuste UX del resultado de Historia

- Orden nuevo: titulo, resumen compacto (antes / despues / diferencia /
  referencia 1951–1980), aviso breve, botones de escucha, voz y estado; el
  relato, la tabla y "Como escucharlo" quedan en un `<details>` nativo
  ("Ver datos y como interpretarlos"). "Sin dato" sigue visible en el resumen.
- Tras "Ver mi historia" (envio explicito) el foco va al titulo del resultado
  (`tabindex=-1`) con scroll al titulo (instantaneo con reduced-motion). Un
  enlace compartido no mueve el foco ni arranca audio.
- Credito GeoNames · CC BY 4.0 junto al buscador; ya no se muestran SHA, zip,
  `cities15000` ni fecha de preparacion en la UI (siguen en JSON y docs).
  Busqueda con singular ("1 resultado" / "1 result").
- Comprobado (Chromium automatizado, 1280x720 y 360x800): `verify_history.py`
  100/100 (incluye foco en el titulo, primer Escuchar visible bajo la barra de
  audio, sin desbordamiento horizontal, Enter/Espacio en el detalle, axe ES/EN
  de Historia), escenario `late-response` 8/8, `npm test` 254 OK y
  `npm run build` salida 0. No se repitio audio 71, 105 axe completo ni la
  exportacion de datos. Sigue pendiente NVDA/VoiceOver, oido humano y telefono
  fisico.

### Tarea 15e: marcadores de Peru solo en la pestana Peru

- Los 3 marcadores POI de Peru (`peru-markers.js`) nacen ocultos y se muestran
  solo con `activeTab === 'peru'` (`setVisible` + `requestRender` solo si
  cambia la visibilidad). El marcador del punto seleccionado no cambia.
- Comprobado con Playwright focal (Chromium, servidor dev): `show` es false en
  Historia/Explorar/Accesible/DJ y true en Peru; el marcador de seleccion se
  conserva y el boton de sitio de Peru sigue funcionando. `npm test` 254 OK y
  `npm run build` salida 0. No se repitieron las baterias 105/71/100.
