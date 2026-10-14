# Investigacion de fuentes alternativas anonimas — incendios y hielo marino (2026-10-09)

Este documento es un registro de evidencia para que Codex revise ANTES de
integrar nada al pipeline (`public/data/`, `dj-index.json`, UI o mixer). No
se activo ningun canal ni se modifico `public/data/`. Los originales reales
descargados estan en `work/raw-pending/` (fuera de `public/`).

No se usaron credenciales: no existe `FIRMS_MAP_KEY` ni `EARTHDATA_TOKEN` ni
`~/.netrc` en este entorno. Todas las peticiones de abajo son HTTP anonimas
reales (comando `curl` mostrado), no supuestos.

## Resumen

| Dataset | Resultado | Fuente usable |
|---|---|---|
| Incendios (fires) | **Sigue bloqueado** para datos reticula reales de 2023 sin login | Ninguna encontrada que cumpla el estandar pedido |
| Hielo marino (sea ice) | **Exito**: datos reticulares reales, anonimos, documentados | NOAA/NSIDC G02135 "Sea Ice Index" v4.0 (GeoTIFF concentracion mensual) |

## 1. Incendios — pistas investigadas y por que se descartan

### 1.1 NASA FIRMS API / Download Tool (ya documentado en `docs/dj-data-sources.md`)
Sigue bloqueado: `/api/area/csv/` exige MAP_KEY (HTTP 400 "Invalid API call."
sin clave). No se repite la verificacion aqui porque no cambio.

### 1.2 FIRMS Global 24h CSV (anonimo, sin MAP_KEY) — descartado por cobertura temporal
```
curl -s "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv"
```
HTTP 200, SIN login. Pero el contenido son detecciones de **las ultimas 24h
en tiempo real** (`acq_date` = fecha de hoy, 2026-10-08/09), no un archivo
historico. No sirve para enero/septiembre 2023. Descartado por no ser
historico, no por bloqueo de acceso.

### 1.3 LAADS DAAC (`ladsweb.modaps.eosdis.nasa.gov/archive/allData/61/MOD14A1/...`)
```
curl -sL -o /dev/null -w '%{http_code} %{url_effective}' \
  "https://ladsweb.modaps.eosdis.nasa.gov/archive/allData/61/MOD14A1/2023/001/"
```
HTTP 200, pero la respuesta es la aplicacion web (SPA) de LAADS, no un
listado de directorio ni el archivo HDF en si. La descarga real de archivos
HDF de LAADS exige un token de Earthdata (Authorization header), incluso
cuando la pagina web carga sin login. No se intento sortear el token.
Descartado: requiere credenciales para el archivo real, solo la pagina HTML
carga sin ellas.

### 1.4 NASA NEO (`neo.gsfc.nasa.gov/archive/csv/MOD14A1_M_FIRE/`) — descartado por documentacion propia de NASA
Pista de Codex. Verificacion real:

```
curl -sL -o /dev/null -w '%{http_code} %{url_effective}' \
  "https://neo.gsfc.nasa.gov/archive/csv/MOD14A1_M_FIRE/"
```
Resultado: **HTTP 200** pero `url_effective` = `https://science.nasa.gov/earth/nasa-earth-observations-neo/`
(redireccion 301). **NEO esta retirado**; `neo.gsfc.nasa.gov` ya no sirve
ningun archivo en vivo (confirmado tambien para `/view.php` y `/servlet/RenderData`,
todos redirigen a la pagina de retiro).

**Via Wayback Machine (snapshot historico, no se sortea nada: es un archivo
publico de paginas ya publicadas por NASA):**
```
curl -s "http://archive.org/wayback/available?url=neo.gsfc.nasa.gov/archive/csv/MOD14A1_M_FIRE/"
# -> snapshot 20250621111543 (listado de directorio)
curl -s "https://web.archive.org/cdx/search/cdx?url=neo.gsfc.nasa.gov/archive/csv/MOD14A1_M_FIRE&matchType=prefix&output=json&limit=5000"
```
Hallazgos del CDX (116 snapshots individuales en total, cobertura **parcial y
aleatoria**, no sistematica — el crawler de Internet Archive no visito todos
los meses):
- **Septiembre 2023 SI tiene snapshot real del archivo**:
  `MOD14A1_M_FIRE_2023-09.CSV.gz` (snapshot `20250318083022`, HTTP 200,
  `application/x-gzip`, 336238 bytes). Descargado a
  `work/raw-pending/fires/MOD14A1_M_FIRE_2023-09.CSV.gz`
  (sha256 `96cf08f3...3b0f2`, ver `work/raw-pending/fires/SHA256SUMS.txt`),
  descomprimido a `MOD14A1_M_FIRE_2023-09.CSV` (sha256 `e0390118...e7f6f58`).
- **Enero 2023 NO tiene snapshot del archivo** (ni en la lista completa de
  116 URLs, ni via `wayback/available` para esa URL exacta — respuesta vacia
  `{"archived_snapshots": {}}`). Solo se archivaron de 2023: 06, 07, 08, 09,
  10, 11, 12. No se puede obtener un par enero+septiembre comparable para
  2023 por esta via.

**Contenido real inspeccionado** (`MOD14A1_M_FIRE_2023-09.CSV`, 1800 filas x
3600 columnas = reticula global 0.1 grados, valor de relleno `99999.0`,
rango de valores reales `0.1`-`30.0`).

**Por que se descarta como "original cientifico" pese a tener datos reales**:
la propia documentacion de NASA (FAQ de NEO, snapshot Wayback
`20260501182619`, guardada en
`work/raw-pending/docs-evidence/neo_faq_20260501182619.html`) dice
textualmente:

> "NEO provides the ability for users to download CSV (...) files for each
> visualization. **The values included in these files (...) are based on
> resampled and scaled ranges of the original source data. As such, these
> values are a few generations removed from the original data values** (...)
> they should not be treated as a substitute for the source data."

Ademas la pagina del dataset (snapshot `20260814170625`, guardada en
`work/raw-pending/docs-evidence/neo_view_MOD14A1_M_FIRE_20260814170625.html`)
describe la escala como un conteo **dentro de un area de 1000 km²** con
"White pixels show the high end of the count — as many as 30 fires" — el
maximo real observado en el CSV es exactamente `30.0`, consistente con un
techo de escala de visualizacion, no con un conteo sin limite. Esto confirma
la instruccion del usuario: **no se puede presentar esta exportacion como
"original cientifico exacto"**; NASA mismo advierte que es una aproximacion
"varias generaciones" removida del dato original (MOD14A1/MODIS activo fire
L3). No se genero ningun JSON de incendios a partir de este archivo.

### Conclusion incendios
Ninguna fuente anonima encontrada cumple el estandar pedido (original
cientifico verificable, no aproximado, con cobertura real para los meses
objetivo). **No se genero ningun JSON de incendios.** Las opciones que
quedan requieren credenciales (FIRMS MAP_KEY, Earthdata Login para LAADS) y
siguen bloqueadas por instruccion explicita de no registrarlas.

## 2. Hielo marino — exito: NOAA/NSIDC G02135 "Sea Ice Index" v4.0

### Pista de Codex descartada primero
`https://earth.gsfc.nasa.gov/cryo/data/current-state-sea-ice-cover` (HTTP 200
anonimo, guardado en
`work/raw-pending/docs-evidence/earth_gsfc_cryo_current-state-sea-ice-cover.html`)
es una pagina de **graficos/figuras** (PNG de tendencias), no un repositorio
de datos reticulares descargables. Cita como fuente real a NSIDC-0079
(Bootstrap), que exige el mismo login de Earthdata ya documentado. El enlace
a Zenodo (`doi.org/10.5281/zenodo.17184409`, "NASA GSFC Current State of Sea
Ice Cover Image Archive") tampoco sirve: son archivos `.zip` de imagenes PNG
semanales de 2025-2026, sin datos numericos y sin cobertura de 2023.

### Fuente real usada: NOAA/NSIDC G02135 v4.0 (GeoTIFF mensual de concentracion)
Hallazgo por explorar el mismo host (`daacdata.apps.nsidc.org`) con una ruta
NOAA en vez de la ruta `DATASETS/` que exige login:

```
curl -s "https://noaadata.apps.nsidc.org/NOAA/G02135/"
curl -s "https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/geotiff/01_Jan/"
```
HTTP 200 anonimo en todos los casos (sin redireccion a `urs.earthdata.nasa.gov`).
Listado de directorio real (Apache autoindex), con series mensuales
completas desde 1979 hasta 2026 para cada mes calendario, ambos hemisferios.

**Archivos reales descargados** (anonimos, HTTP 200) a
`work/raw-pending/sea-ice/` (hashes en
`work/raw-pending/sea-ice/SHA256SUMS.txt`):

| Archivo | URL | Tamano | sha256 (prefijo) |
|---|---|---|---|
| `N_202301_concentration_v4.0.tif` | `.../north/monthly/geotiff/01_Jan/N_202301_concentration_v4.0.tif` | 666261 B | `49234101...` |
| `N_202309_concentration_v4.0.tif` | `.../north/monthly/geotiff/09_Sep/N_202309_concentration_v4.0.tif` | 666261 B | `9ee73546...` |
| `S_202301_concentration_v4.0.tif` | `.../south/monthly/geotiff/01_Jan/S_202301_concentration_v4.0.tif` | 606187 B | `85b6b5fb...` |
| `S_202309_concentration_v4.0.tif` | `.../south/monthly/geotiff/09_Sep/S_202309_concentration_v4.0.tif` | 603659 B | `10dd795c...` |

(prefijo de URL comun: `https://noaadata.apps.nsidc.org/NOAA/G02135/`)

### Validacion de que SON datos cientificos, no colores de PNG
Se leyeron los pixeles crudos (no el color de visualizacion) con
`tifffile` (banda unica, `uint16`, formato GeoTIFF paleta-color donde la
paleta es solo para visualizacion; el valor de banda es el dato):

```python
import tifffile
im = tifffile.imread("N_202301_concentration_v4.0.tif")
# shape (448, 304), dtype uint16, min=0, max=2540
```

- Rango de valores: `0`-`1000` para hielo valido (factor **x10**: valor/10 =
  porcentaje de concentracion 0.0-100.0%, resolucion de 0.1%).
- Valores especiales encontrados exactamente: `2510`, `2530`, `2540` →
  divididos por 10 dan `251` (pole hole), `253` (costa), `254` (tierra),
  **la misma convencion de flags documentada para NSIDC-0051** (verificado:
  no son valores inventados, coinciden exacto con la tabla de flags ya
  usada por `scripts/prepare_sea_ice.py`).
- Dimensiones de rejilla: Norte 304x448, Sur 316x332 — coinciden con la
  rejilla polar estereografica NSIDC de 25 km (misma familia que
  NSIDC-0051).
- Proyeccion confirmada en la pagina oficial del dataset
  (`https://nsidc.org/data/g02135/versions/4`, guardada en
  `work/raw-pending/docs-evidence/nsidc_g02135_versions_4.html`):
  **EPSG:3411** (norte) / **EPSG:3412** (sur), resolucion **25 km**,
  idéntica a la que ya usa `scripts/prepare_sea_ice.py` con `pyproj`.

### Por que esto NO es "dataset NASA puro" y como se debe etiquetar
Por instruccion explicita: este producto es **G02135 "Sea Ice Index"**,
distribuido por **NOAA** a traves de NSIDC (no es NSIDC-0051 ni un producto
NASA primario), aunque el algoritmo subyacente es NASA Team en AMBOS casos
(NSIDC-0051 hasta diciembre 2024; NSIDC-0803 desde enero 2025 — la
transicion es de nombre de dataset, no de algoritmo, segun la guia de
usuario G02135 v4 secciones 2.1/2.3/6.4.1) fue desarrollado en NASA GSFC.
**Correccion**:
"Bootstrap" es el algoritmo de NSIDC-0079 (otro dataset, el que usa la
pagina "current state of sea ice cover" de NASA GSFC cryo citada arriba),
no el de G02135 — no deben confundirse. Cualquier integracion futura debe
etiquetar el
`dataset` como `"NOAA/NSIDC G02135 Sea Ice Index v4.0 (derivado de
algoritmos NASA GSFC)"`, **nunca** como "NASA dataset puro", siguiendo la
distincion que pidio el usuario.

### Diferencias de esquema frente a `scripts/prepare_sea_ice.py` (NSIDC-0051)
- NSIDC-0051 usa variable `<SENSOR>_ICECON` con escala 0-250 (factor
  100/250); G02135 usa escala **0-1000 (factor 1/10)** — unidades y factor
  de conversion DISTINTOS, no intercambiables sin un script nuevo.
  `scripts/prepare_sea_ice.py` NO debe reutilizarse tal cual para esta
  fuente: haria falta un script especifico (ej. `prepare_sea_ice_g02135.py`)
  que declare su propia procedencia, factor de escala y el nombre de
  dataset correcto (NOAA G02135, no NSIDC-0051) para no mezclar dos
  productos distintos bajo la misma etiqueta.
- Formato de entrada: GeoTIFF paleta-color de banda unica (no NetCDF), por
  lo que se necesita `tifffile` (o `rasterio`/`gdal`) en vez de `netCDF4`.
  `tifffile` no esta en `scripts/requirements-dj.txt`; habria que agregarlo
  si Codex aprueba continuar con esta fuente.
- Cobertura geografica: G02135 cubre el oceano polar completo por
  hemisferio (igual que NSIDC-0051), reproyectable a la misma rejilla
  destino de 2 grados con el mismo metodo de agregacion ya implementado
  (promedio de pixeles oceanicos validos, excluyendo tierra/costa/pole
  hole).

### Que falta para integrar (no hecho en esta tarea, a proposito)
No se escribio el script de conversion a JSON ni se tocaron
`public/data/sea-ice/` ni `dj-index.json`: esta tarea es solo de
investigacion y descarga de originales verificables, para que Codex revise
el enfoque (nombre de script, factor de escala, etiqueta de dataset) antes
de generar salidas que alimenten la UI. Los 4 archivos GeoTIFF originales
quedan en `work/raw-pending/sea-ice/` listos para ese paso siguiente.

## 3. Serie temporal disponible si se aprueba continuar
`https://noaadata.apps.nsidc.org/NOAA/G02135/<hemisferio>/monthly/geotiff/<MM_Mon>/`
tiene un archivo `<N|S>_YYYYMM_concentration_v4.0.tif` por cada mes desde
`197901`/`197911` (segun hemisferio y disponibilidad del sensor) hasta el
mes mas reciente procesado (`202601` visto en el listado), es decir
cobertura real para construir la serie 2000-2025 completa si Codex aprueba
el siguiente paso, sin necesitar login en ningun punto.

## 4. Archivos generados en esta tarea
- `work/raw-pending/fires/MOD14A1_M_FIRE_2023-09.CSV.gz` + `.CSV` descomprimido + `SHA256SUMS.txt` (NO usado para generar ningun JSON final, solo evidencia).
- `work/raw-pending/sea-ice/{N,S}_2023{01,09}_concentration_v4.0.tif` + `SHA256SUMS.txt`.
- `work/raw-pending/docs-evidence/*.html` (snapshots de paginas de documentacion citadas arriba).
- Este archivo (`docs/pending-data-research.md`).

**No se modifico** `public/data/`, `dj-index.json`, `manifest.json`, la UI
ni el mixer. Ningun canal nuevo fue activado.
