# Orquestación y revisión

Programador: Claude Code, selector `sonnet`, modelo observado `claude-sonnet-5`.
Revisor y orquestador: Codex.

## Entrega 1: base y GISTEMP

Estado: base aprobada; ajustes de integración solicitados en entrega 2.

- Proyecto HTML/CSS/JavaScript con Vite, Cesium y Tone instalados.
- Original NASA descargado; rejilla 90 × 180 de enero de 2023.
- JSON: 16 200 celdas, 67 ausentes, 102 679 bytes.
- Revisión independiente: cinco celdas válidas frente al NetCDF, error máximo 9.54e-8; todas las ausencias conservadas como null.
- `npm test`: tres comprobaciones aprobadas.
- `npm run build`: aprobado.

Ajustes solicitados: rutas aptas para subcarpetas, idioma HTML actualizado,
validación de idioma guardado, JSON compacto y metadatos de unidades leídos
del original. Las anomalías expresadas en K tienen la misma magnitud que
las anomalías en °C, sin sumar ni restar 273.15.

## Entrega 2: globo, selección, audio y tiempo

Estado: entrega recibida; 39 pruebas unitarias aprobadas, construcción aprobada.
Revisión en navegador detectó fallos de integración; corrección encargada
en entrega 3. No aprobada todavía como función completa.

- 312 meses de GISTEMP preparados (2000–2025), 26 468 961 bytes totales.
- Fallos detectados: llamada nativa a fetch con receptor incorrecto,
  esquema de teselas GIBS, avisos ocultos visibles y sincronización entre
  clic, marcador, nota y cambio temporal.

## Datos adicionales

Preparadores IMERG/FIRMS/NSIDC escritos por Claude: 11 pruebas Python
aprobadas con fixtures de prueba. No hay datos reales de esos productos
descargados: requieren acceso autenticado NASA no configurado.

Alternativa real disponible: NASA POWER/MERRA-2 PRECTOTCORR para Iquitos,
Quelccaya y mar frente a Piura. 312 meses por punto, unos 6 KB por archivo.
Revisión independiente: los 936 valores y los hashes coinciden con las
respuestas originales. Unidad mm/day (tasa diaria media del mes), no
acumulación mensual ni producto IMERG.

## Entrega 3: correcciones, Perú, accesibilidad y compartir

Estado: entrega recibida. 78 tests y build aprobados; smoke de navegador
ejecutado por Claude. Dependencia vulnerable retirada, assets Cesium
preparados mediante un script local.

Revisión de Codex solicitó ajustes para entrega 4: controles globales de
audio visibles en todas las pestañas y antes de activación, sincronización
de selectores temporales con consultas accesibles, resultado accesible
automático, voz descriptiva optativa y protección de consultas concurrentes.

## Entrega 4: DJ, EIC y verificación final

Estado: 134 tests y build aprobados; smoke de navegador (Playwright)
ejecutado por Claude tras la revisión de Codex. Correcciones aplicadas:
coordenadas vacías ya se rechazan explícitamente (no se cuelan como 0,0);
la voz de narración sigue volumen/mute y un `onstart` tardío de una
utterance cancelada ya no duckea; lugares accesibles actualizan su texto
ES/EN en cada render (antes quedaban fijos en el idioma de carga); se
extrajo `src/app/action-coordinator.js` para que clics/consultas/presets
fuera de orden nunca apliquen una coordenada vieja sobre un periodo
distinto; DJ ya no reinicia el PRNG de lluvia en cada render (solo al
cambiar semilla real), muestra valor/periodo/unidad/fuente/saturación de
lluvia (antes solo fuente), y tiene aria-label único por canal; "Compartir"
se movió fuera de `explore-panel` para estar disponible desde DJ; el preset
ahora restaura BPM/solo por canal, aplica `preset.mode` (antes se ignoraba)
y valida el hash GISTEMP (`dataset.source.original_file_sha256`, antes mal
referenciado) y el `data_version` de POWER, avisando si no coinciden; EIC
precarga la imagen solo al abrir el panel (antes también cerrado) y separa
el texto (inmediato) de la imagen (asíncrona); "Escuchar" del EIC ya no se
habilita sin el motor de audio activado. Ver `docs/acceptance.md` y
`docs/accessibility-review.md` para el detalle de pruebas.

EIC: registro verificado de 2025 con mapa anual SVS 5603 y +1.19 °C de la
publicación NASA del 14 de enero de 2026, respecto a 1951–1980. Se identifica
como indicador global anual, nunca como valor local ni lectura de píxeles.
El CSV global estuvo temporalmente inaccesible; no se atribuye a él este
registro. Los otros mapas no compatibles con el periodo anual se excluyen.

## Entregas restantes

Historias Perú y voz; ruta accesible y pruebas; datasets adicionales y DJ;
presets compartidos; integración EIC, revisión visual y demo.

No hay publicación ni inscripción realizadas. Las funciones pendientes no
se consideran terminadas hasta revisar código, datos y pruebas.

## Entrega 5: dos fallos concretos de Codex corregidos

142 tests y build aprobados. Fallos corregidos:

1. `changePeriod` devolvía `undefined` en éxito y en error; `onQuery`/
   `onApplyPreset` aplicaban el punto igual aunque el periodo hubiera
   fallado. Ahora `changePeriod` devuelve un contrato explícito
   `{ ok, reason }` y se agregó `runGuardedAction` (`src/app/
   action-coordinator.js`), el runner REAL que usa `onQuery`: sin éxito u
   obsoleto, `onSuccess` (aplicar punto/sonificar) nunca se llama. También
   se movió `actionCoordinator` al inicio de `init()` (antes del primer
   `await` y de registrar callbacks) para eliminar la TDZ señalada.
   `tests/action-coordinator.test.js` prueba `runGuardedAction` real (no
   una reimplementación) con fallo, fuera de orden y confirmación
   coherente.
2. `#dj-seed` usaba el evento `change`: un borrador escrito se perdía si
   cualquier otro `store.set` (p.ej. mover el BPM) disparaba un render
   antes del blur. Ahora confirma en cada `input` (como `fill` de
   Playwright dispara) y el render no pisa el campo mientras tiene foco.
   `tests/dj-panel.test.js` reproduce el repro exacto (escribir →
   cambiar BPM → el borrador persiste) y el guardado/restauración exacta.

Ajustes menores: preset ahora fusiona canales en vez de reemplazar
`dj.channels` completo (fuegos/hielo ya no desaparecían del estado) y
fuerza `dj.playing = false` al aplicar un preset. Botón "Home" y enlace de
créditos de CesiumJS localizados ES/EN vía DOM post-render (sin tocar la
librería, ver `src/globe/create-globe.js`). Acentos/ñ corregidos en
`i18n/es.json` y títulos de historias de Perú; `alt` de la imagen EIC
ahora localizado ES/EN (antes siempre el título en inglés de la fuente).

Evidencia real (Playwright, dev server :5181 reutilizado):
- Ruta interceptada a 404 para `gistemp/2023-02.json`: tras enviar la
  consulta Accesible con esas coordenadas/periodo, `#acc-description` NO
  cambió (sigue "sin punto seleccionado") y `#period-status` muestra el
  error — el punto nunca se aplicó sobre la carga fallida.
- DJ: `#dj-seed` = "demo-peru", BPM = 84, solo de temperatura activado,
  "Guardar y generar enlace", reabierto en una pestaña nueva: `#dj-seed`
  y `#dj-bpm` restauran exactamente "demo-peru"/84 y `#audio-toggle`
  sigue en "Activar sonido" (sin autoplay).

## Entrega 6: ajuste visual de layout (globo recortado) y orden del panel

`npm run build` aprobado (`dist/` regenerado). Sin tests nuevos ni
repetición de los 142 existentes (cambio puramente CSS/orden DOM).

- Causa del globo recortado en escritorio: `#app` usaba `min-height:
  100vh` (crece sin tope con el contenido del sidebar) en vez de una
  altura fija al viewport, así que `#app-main`/`#globe-section` podían
  superar los 744px visibles y el centro del planeta quedaba debajo del
  pliegue. Fix (`src/styles.css`, media `min-width: 861px`): `#app`
  pasa a `height: 100vh`/`100dvh` + `overflow: hidden`; `#app-main`,
  `#globe-section` y `#side-panel` reciben `min-height: 0` y el
  sidebar mantiene scroll propio (`overflow-y: auto`). Mobile (`<=
  860px`) no se tocó: sigue en flujo normal con la barra de audio
  sticky.
- `#share-section` se movió en `index.html` al final de `#side-panel`
  (tras `#dj-panel`), sin cambiar su id ni listeners; antes aparecía
  entre `explore-panel` y `peru-panel`, por lo que ocupaba los primeros
  píxeles visibles en la pestaña DJ.
- Filas de fuegos/hielo pendientes en el panel DJ (`src/ui/dj-panel.js`
  añade la clase `.is-pending`; `src/styles.css` oculta con ella los 3
  controles deshabilitados — activar, solo, slider de ganancia) ya no
  restan espacio a los 2 canales reales; título y nota de "datos
  pendientes" siguen visibles.
- Verificación: build limpio confirmado. No se pudo correr el smoke de
  Playwright (`work/playwright-smoke.cjs`) contra los servidores
  :5181/:5182 reutilizados porque el módulo `playwright` no está
  instalado en `node_modules` de este entorno (solo queda como
  dependencia transitiva de Vitest, sin binarios descargados); no se
  instalaron paquetes ni navegadores nuevos para no crear servidores o
  dependencias huérfanas. La verificación se hizo por inspección directa
  de las reglas CSS resultantes (altura/overflow de `#app` y cadena
  `min-height:0`) y del DOM final de `index.html`/`dj-panel.js`.

## Revisión independiente final — Codex, 9 de octubre de 2026

- Suite completa: 142 pruebas aprobadas (14 archivos). Ajuste final de CSS/orden DOM compilado por Claude; no repitió pruebas unitarias para ese cambio visual.
- Versión compilada servida en :5182: consulta accesible Iquitos 2023-01, mezcla con lluvia local 12.14 mm/day, selectores sincronizados y audio inicialmente inactivo.
- API pública POWER desde el navegador: punto -10,-75, diciembre de 2025, respuesta 1.31 mm/day; procedencia MERRA-2 y periodo mostrados. Esta comprobación demuestra la consulta fuera de los tres puntos precargados; depende de red y disponibilidad de NASA.
- Compartir y recargar: semilla demo-peru, BPM 48 y solo de lluvia conservados; audio muestra Activar sonido y reproducción false.
- Escritorio 1280x720: página 720px, visor entre y=137.45 y y=656.15, línea de tiempo hasta y=720; planeta completo visible y panel con desplazamiento independiente.
- Móvil 360x800: ancho de contenido 345px, sin desbordamiento horizontal. Tras desplazar la página, silencio y volumen permanecen en y=73.19..117.19; controles de 44px.
- Captura real de la versión compilada guardada en outputs/earth-jukebox-preview.jpg (carpeta padre del proyecto).

Entrega: versión funcional local y código fuente listo para alojamiento estático. Siguen pendientes los datos autenticados de incendios/hielo y las pruebas con lectores de pantalla, voces, audio audible y teléfonos físicos. No se afirma una validación con esas personas/dispositivos ni una publicación pública.
