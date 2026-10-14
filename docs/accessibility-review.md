# Revision de accesibilidad (Fase 4) y notas de entrega

Este documento resume que se implemento, como se verifico, y que queda
pendiente de verificacion real (NVDA, lectores de pantalla moviles,
dispositivos fisicos).

## Que se implemento

- **Pestanas Explorar / Peru / Accesible** (`src/ui/tabs.js`): grupo simple
  de botones nativos con `aria-pressed`, igual patron que el selector de
  idioma ya existente. Se eligio deliberadamente NO usar el patron ARIA
  "tabs" con roving tabindex y flechas, para no tener que interceptar
  teclas (ver `src/accessibility/keyboard.js`).
- **Ruta 100% accesible por HTML** (`src/ui/accessible-panel.js`,
  `#accessible-panel` en `index.html`): formulario con latitud/longitud
  validadas estrictamente (-90..90 / -180..180, rechazadas, nunca saturadas
  silenciosamente), selector de periodo, variable fija (GISTEMP), botones
  Consultar / Escuchar / Describir estado / Comparar A-B, y una lista de
  "lugares de ejemplo" (reutiliza `public/data/peru-stories.json`). Esta
  ruta NUNCA depende del canvas de Cesium: se probo explicitamente con el
  globo inicializado y debe seguir funcionando si `createGlobe()` devuelve
  `viewer: null` (WebGL no disponible), porque ningun handler de este panel
  toca `globeHandle`.
- **`describeState()`** (funcion pura, exportada y testeada en
  `tests/accessible-panel.test.js`): arma la descripcion completa
  (ubicacion, periodo, anomalia, unidad, linea base, nota de significado,
  estado de audio) diferenciando explicitamente:
  - celda sin dato (`value === null`) vs. celda con anomalia 0 (dato real);
  - audio muteado ("silencio elegido por ti") vs. audio activo vs. audio
    nunca activado.
- **Narracion por voz opt-in** (`src/accessibility/narration.js`): usa
  `SpeechSynthesis` solo cuando el usuario pulsa "Escuchar historia"; nunca
  arranca sola (para no competir con un lector de pantalla activo). Cancela
  la narracion anterior antes de empezar una nueva o al cambiar de idioma;
  el silencio global (boton de mute) tambien cancela la narracion
  (`src/ui/controls.js`). Mientras narra, reduce (duckea) la musica/sintesis
  vía `AudioEngine.setDucked()` y la restaura al terminar o cancelar, sin
  tocar el mute del usuario. Si `window.speechSynthesis` no existe, 
  `isSupported()` devuelve `false` y el boton de narracion se oculta: el
  texto de la historia sigue visible igual.
- **Teclado minimo y deliberado** (`src/accessibility/keyboard.js`): solo
  conecta el salto de "skip link" al contenido principal. Explicitamente NO
  se agregan atajos de una sola letra ni se intercepta `keydown` sobre
  inputs/selects: toda la navegacion se apoya en Tab/Shift+Tab/Enter nativos
  y en los propios controles del navegador (selects, range, number inputs).
- **Foco visible**: `:focus-visible` con contorno de alto contraste
  (`--focus: #a65d00`) ya existia en el tema base y se mantiene para todos
  los controles nuevos (no se usa `outline: none` en ningun lado).
- **Objetivos tactiles >= 44px** y **contraste >= 4.5:1**: los nuevos
  botones reutilizan `.action-btn`/`.tab-btn` (min-height/min-width 44px) y
  los colores del tema ya validado (`--text`, `--action`, `--border`,
  `--focus`). El color de error (`#a6291f` sobre blanco) se calculo con
  ~7.1:1 de contraste (pasa AA y practicamente AAA para texto normal).
- **`prefers-reduced-motion`**: ya existia una regla global que reduce
  duraciones de animacion/transicion; ademas, `flyToPoint()` en `main.js`
  usa `camera.setView()` (sin animacion) en vez de `camera.flyTo()` cuando
  `matchMedia('(prefers-reduced-motion: reduce)').matches` es verdadero.
- **Sin overflow horizontal a 360px**: layout basado en flexbox con
  `flex-wrap` y `min-width: 0` en los contenedores principales; verificado
  (ver abajo) con un viewport real de 360x740.
- **Idioma de documento completo**: `document.documentElement.lang` se
  actualiza en cada cambio de idioma (`setLang` en `main.js`, ya existia);
  todos los textos nuevos (pestanas, panel Peru, panel accesible, compartir)
  pasan por el diccionario `src/i18n/{es,en}.json`.

## Como se verifico

Se instalo Playwright (Chromium) de forma temporal (`npx playwright install
chromium`, sin agregarlo a `package.json`) y se corrio un script ad-hoc
(`scripts/smoke-check.mjs`) contra `vite` en modo dev, cubriendo:

- Las 3 pestanas renderizan sin errores de consola ni `pageerror`.
- Las solicitudes WMTS reales a `gibs.earthdata.nasa.gov` devuelven `200` en
  varios niveles de zoom (0 a 4), y la imagen de NASA Blue Marble se ve
  correctamente (continentes/oceanos reales, verificado con una captura sin
  el overlay numerico encima).
- Formulario accesible: coordenadas invalidas (`lat=200`) muestran el
  mensaje de error y NO disparan la consulta (se agrego `novalidate` al
  `<form>` para que la validacion y el mensaje sean siempre los nuestros, no
  el tooltip nativo del navegador, que bloqueaba el `submit` sin mostrar
  nuestro texto).
- Consulta valida (Iquitos) + "Describir estado" produce el texto esperado,
  incluyendo el periodo por defecto correcto (el mas reciente del
  manifiesto, no el mas antiguo: se corrigio un bug donde el `<select>` de
  periodo del panel accesible quedaba en su primera opcion por defecto).
- Flujo Explorar: activar sonido, click en el globo, "Escuchar punto",
  Comparar A/B (A y B del MISMO punto en dos periodos distintos: comparar
  dos lugares distintos esta invalidado a proposito, ver
  `recomputeSelectedCell` en `src/main.js`) produce el resultado esperado.
- Panel Peru: visitar un sitio vincula el valor real de la celda GISTEMP
  mas cercana (`+1.15 K (2025-01)` en la corrida de prueba).
- Viewport de 360x740: `document.documentElement.scrollWidth === clientWidth`
  (sin overflow horizontal) en las 3 pestanas.

Capturas de pantalla de estas corridas (no versionadas, se generaron en un
directorio temporal del entorno de desarrollo).

## Pendiente (NO verificado en esta entrega)

- **NVDA / JAWS / VoiceOver reales**: no se ejecuto ningun lector de
  pantalla real sobre la app. La verificacion de accesibilidad se hizo por
  inspeccion de codigo + Playwright (DOM/ARIA/contraste/overflow), no por
  escucha real de un lector de pantalla. Esto queda pendiente de una sesion
  de pruebas manual con NVDA (Windows) y, si aplica, VoiceOver (iOS/macOS) y
  TalkBack (Android).
- **Dispositivos tactiles reales**: los objetivos de 44px y el layout
  responsivo se verificaron con viewports emulados en Chromium headless, no
  en hardware tactil real (movil/tablet).
- **Voces de SpeechSynthesis reales**: la preferencia es-PE/es/en en
  `src/accessibility/narration.js` se probo contra la lista de voces
  disponible en el Chromium headless del entorno de CI/dev, que puede no
  tener ninguna voz en espanol instalada; el comportamiento con voces reales
  de Windows/macOS/Android no se verifico.

## Actualizacion (fase 5-6): barra de audio global y sincronizacion

- **Corregido**: `#audio-controls` (Silencio/Volumen) estaba DENTRO de
  `#explore-panel` y `#volume-row` se ocultaba hasta activar sonido —
  incumplia "SIEMPRE visible" y dejaba sin controles visibles la narracion
  en Peru/Accesible/DJ. Ahora es una barra `position: sticky` fuera de
  TODA pestana/panel (`src/styles.css`, `index.html`), confirmado con
  Playwright headless en viewport 360x800 antes y despues de scroll (ver
  `docs/acceptance.md`).
- **Corregido**: tras una consulta Accesible/Peru/preset, `year-select`/
  `month-select`/`year-range` del pie quedaban en el periodo anterior
  mientras `period-status` ya mostraba el nuevo; y `#acc-result` no tenia
  valor hasta pulsar "Describir". Ambos se corrigieron (`timeline.js`
  reconcilia en cada render; `accessible-panel.js` auto-describe por
  texto/`aria-live`) y se agrego `tests/integration-accessible-sync.test.js`
  para evitar una regresion silenciosa de este recorrido.
- Nuevo opt-in "Voz de navegacion" (`#acc-narration-auto`, default OFF):
  anuncia por voz el estado confirmado con debounce de 700 ms, nunca con
  mute activo ni al abrir un enlace; "Describir" sigue siendo el gesto
  explicito que siempre habla (ademas de actualizar el texto).

## Actualizacion (entrega 4)

- **Corregido**: los botones de "Lugares de ejemplo" (Accesible) cargaban
  su texto ES/EN una sola vez al iniciar y quedaban fijos en ese idioma al
  cambiar de idioma despues. Ahora se refrescan en cada render.
- **Corregido**: los controles de canal del DJ (activar/solo/ganancia)
  compartian el mismo `aria-label` generico entre temperatura y lluvia, 
  imposible de distinguir por voz; ahora cada uno incluye el nombre del
  canal.
- **Corregido**: titulos de "Historias de Peru" y textos cercanos sin
  tilde ("Peru", "El Nino", "Sequia") se corrigieron con su acento
  correcto en ES/EN donde aplica (nombre propio).
- Formulario Accesible: enviar con un campo vacio ahora se rechaza con el
  mismo mensaje de "coordenadas invalidas" en vez de interpretarse como 0.

## Actualizacion (fase 12): auditoria real con axe-core + Python Playwright

Script permanente: `scripts/verify_accessibility.py`. Usa **axe-core
real** (obtenido con `npm pack axe-core` desde el registro oficial de npm
a `work/axe-tmp/`, extraido con `tar -xzf`; NO se agrego a
`package.json` ni a `node_modules`, no es una dependencia de runtime) +
**Python Playwright** (Chromium real, ya instalado en este entorno) con
navegacion por teclado real (foco directo en cada control + Tab/Enter/
Espacio, sin ningun atajo propio — mismo contrato que
`src/accessibility/keyboard.js`). Corrida en ES/EN × 360x800 (movil) ×
1280x720 (escritorio): **36/36 verificaciones OK**.

**Hallazgo real corregido**: `<nav id="section-tabs">` (`index.html`)
tenia `role="group"` explicito, un rol NO permitido sobre un elemento
`<nav>` segun ARIA-en-HTML (regla axe `aria-allowed-role`). Se quito el
atributo: `<nav>` ya provee implicitamente `role="navigation"` (semantica
igual o mas apropiada para un conjunto de pestanas de secciones), sin
perder el `aria-label` existente.

**Verificacion de keyboard-UX directa**: en vez de simular una caminata
de `Tab` genérica (fragil, depende del orden exacto de otros controles),
el script enfoca CADA control relevante directamente con `.focus()` y
confirma con `document.activeElement` antes de presionar `Enter`/
`Espacio`: boton de pestana DJ, campo de latitud del formulario Accesible,
boton Consultar, boton de silencio/volumen, boton de compartir. Los 4
combos ES/EN×movil/escritorio pasan sin violaciones de axe ni en la
pagina inicial ni en la pestana DJ.

No se repitio aqui la verificacion de enlace de preset con
`dataVersions` incompatible ni la consulta NASA POWER en vivo fuera de
Peru (3 canales DJ compartidos, sin autoplay): ya se verificaron de punta
a punta en una corrida anterior y la logica de compartir/POWER no cambio
desde entonces (ver `docs/acceptance.md`).

Pendiente sigue igual que antes: NVDA/JAWS/VoiceOver/TalkBack reales,
telefono fisico, voces de `SpeechSynthesis` reales (Chromium headless
expone la API pero con 0 voces en este entorno; Windows SI tiene 3 voces
en ingles a nivel de sistema — David/Mark/Zira, ninguna en espanol —
confirmadas por lectura de registro de solo lectura, pero Chromium
headless no las usa).
