# Earth Jukebox

Proyecto para NASA Space Apps 2026. Visualizacion 3D (CesiumJS) y
sonificacion (Tone.js) de datos climaticos terrestres, sin backend.

## Estado actual

- **Tu historia con la Tierra** (tarea 15, pestana inicial): elige una
  ciudad (catalogo GeoNames local, CC BY 4.0) y el mes y ano en que naciste;
  compara la anomalia de ese mes con el ultimo mes real disponible (2026-08)
  y escucha ANTES y DESPUES con la misma frase, semilla, tempo y volumen.
  Solo anomalias mensuales (no temperatura absoluta ni el clima del dia).
  Secuencia automatica y voz son opt-in; nunca suena sola.
- **Explorar**: globo 3D + GISTEMP mensual 1880-01 a 2026-08 (rejilla 2°), overlay
  numerico, comparacion A/B, compartir por enlace.
- **Peru**: historias climaticas con celda GISTEMP mas cercana.
- **Accesible**: ruta HTML operable con teclado, con resultado auto-descrito
  (texto, `aria-live`) y "Voz de navegacion" opt-in. Pendiente verificar con
  lectores de pantalla reales (NVDA/VoiceOver) y telefono fisico; no es una
  certificacion de accesibilidad.
- **DJ**: mezcla temperatura (GISTEMP) + lluvia (NASA POWER
  PRECTOTCORR/MERRA-2) + hielo marino (NOAA/NSIDC G02135, serie 2023
  completa) del punto seleccionado sobre un pulso compartido 48-96 BPM,
  semilla reproducible. **El canal de hielo solo tiene datos reales para
  2023**: elige primero un periodo de 2023 en la linea de tiempo/Accesible
  ANTES de usar los botones "Explorar hemisferios" (puntos reales con
  cobertura verificada, ver `docs/pending-data-research.md`); esos botones
  solo cambian el punto seleccionado, no el periodo. Fuera de 2023 el
  hielo queda explicitamente "sin dato" (nunca se extrapola). Incendios
  sigue deshabilitado ("datos pendientes de autenticacion NASA"): FIRMS
  requiere login NASA Earthdata que esta tarea no sortea (ver
  `docs/dj-data-sources.md`).
- **Composicion musical (tarea 14)**: en la pestana DJ, el boton
  "Escuchar composicion (20 s)" toca una pieza finita de 8 compases 4/4 a
  96 BPM con tres instrumentos sintetizados con Tone.js (piano suave =
  temperatura, gotas = lluvia, pad cristalino = hielo). Nunca empieza sola;
  parar/volumen/mute siguen visibles; el DJ continuo se mantiene. Reglas,
  rangos y cuantizacion en `docs/sonification-rules.md`. Los enlaces
  compartidos pasan a preset v3 (con bloque `music`); los v2 abren sin
  autoplay y con aviso.
- **Recursos EIC** (nuevo, en Explorar): mapa anual oficial NASA SVS 2025 +
  indicador GLOBAL ANUAL (+1.19 °C, mismo dataset/baseline) sonificable.
  Solo se ofrece 2025 (unico anio con frame y dato verificados juntos; ver
  `docs/eic-integration.md`).

Ver `docs/acceptance.md` para el detalle de que se probo realmente y que
queda pendiente, y `docs/demo-script.md` para un recorrido guiado de 3 min.

## Stack

- HTML / CSS / JavaScript (ESM)
- Vite 8
- CesiumJS 1.146 (assets servidos como estaticos en `/cesium`)
- Tone.js 15
- Vitest 5
- Python (solo para el script de preparacion de datos en `scripts/`)

## Requisitos

- Node.js `^20.19.0 || >=22.12.0` (requisito real de Vite 8, ver
  `node_modules/vite/package.json` `engines.node`; Node 20.0-20.18 NO
  cumple) y npm
- Python 3.11+ (solo para regenerar datos)

## Instalacion

```bash
npm install
```

## Desarrollo

```bash
npm run dev
```

## Build de produccion

```bash
npm run build
npm run preview
```

Cesium se empaqueta en su propio chunk separado (`cesium-*.js`, ~4.2 MB)
del resto de la app (`index-*.js`, ~420 KB) via
`build.rolldownOptions.output.codeSplitting` en `vite.config.js` — Vite 8
usa Rolldown, no Rollup; la API clasica `rollupOptions.output.manualChunks`
no separa nada en este bundler.

## Despliegue (GitHub + Netlify)

La app es un sitio estatico (Vite): no hay backend, funciones ni variables
secretas. Netlify solo necesita ejecutar el build y publicar `dist/`.

1. **GitHub**: sube el repositorio. `.gitignore` excluye `node_modules/`,
   `dist/`, `public/cesium/` (se regenera en cada build), `work/`, caches,
   `.env*` y credenciales. Los JSON de `public/data/`, `docs/`, `scripts/`,
   `tests/` y `package-lock.json` si se versionan.
2. **Netlify**: importa el repositorio. `netlify.toml` ya define
   `npm run build`, carpeta de publicacion `dist` y Node 22 (Vite 8 requiere
   `^20.19.0 || >=22.12.0`).
3. **Lo que hace el build** (equivalente local: `npm ci` -> `npm run build`
   -> `dist/`): el hook `prebuild` copia los assets de Cesium (Workers,
   Assets, Widgets, ThirdParty) a `public/cesium/`, y `vite build` los copia
   junto con `public/data/` a `dist/`.
4. **Datos**: GISTEMP (anomalias mensuales 1880-01 a 2026-08), el catalogo de
   ciudades y los demas JSON viajan como instantaneas locales dentro de
   `dist/data/`. Las capas de imagen de NASA GIBS y los datos de NASA POWER
   se piden desde el navegador a servidores externos (otro origen), asi que
   dependen de esa red y de su disponibilidad. La app muestra el ultimo mes
   real disponible; no garantiza datos exactos del dia ni "actuales".
5. No hay regla SPA ni redirecciones: la app usa enlaces con `#`, y un JSON
   o asset faltante debe devolver 404 y no una pagina HTML.

La URL publica se agregara aqui cuando exista un despliegue real.

## Tests

```bash
npm test
```

Incluye una prueba (`tests/gistemp-export.test.js`) que compara al menos 5
celdas del JSON exportado (`public/data/gistemp/2023-01.json`) contra el
NetCDF original descargado en `work/raw/`, mas una celda ausente (`null`)
conocida. Si `work/raw/gistemp1200_GHCNv4_ERSSTv5.nc.gz` no esta presente
localmente, la prueba se omite (no se inventan datos ni se descarga
automaticamente durante `npm test`).

## Preparacion de datos (GISTEMP)

```bash
pip install -r scripts/requirements.txt
python scripts/prepare_gistemp.py            # descarga desde NASA GISS y exporta 2023-01
python scripts/prepare_gistemp.py --input ruta/local/archivo.nc.gz --year 2023 --month 1
```

Detalles de la fuente, el formato exportado y el metodo cientifico en
`docs/data-sources.md` y `docs/science-method.md`. El hielo marino
(NOAA/NSIDC G02135) se prepara con `scripts/prepare_sea_ice_g02135.py`
(ver `docs/pending-data-research.md`).

## Verificacion real de audio y accesibilidad (opcional)

Scripts Python separados (no forman parte de `npm test`, requieren un
servidor Vite dev y dependencias opcionales, ver
`scripts/requirements-browser-tests.txt`):

```bash
npx vite --port 5181
py -3 scripts/verify_audio_offline.py --base-url http://localhost:5181   # escribe ../outputs/earth-jukebox-demo.wav (composicion de 20 s)
py -3 scripts/verify_accessibility.py --base-url http://localhost:5181
py -3 scripts/verify_history.py --base-url http://localhost:5181 --scenario late-response   # solo el caso de respuesta tardia
```

Detalle completo en `docs/audio-verification.md` y
`docs/accessibility-review.md`.

## Estructura

```
src/            Codigo fuente de la app (ESM)
  i18n/         Textos ES/EN
scripts/        Preparacion de datos (Python)
public/data/    JSON generados + manifest.json (solo archivos reales)
docs/           Documentacion de datos y metodo
work/raw/       Descargas originales (ignorado por git)
```
