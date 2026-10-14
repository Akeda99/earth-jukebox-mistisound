# Fuentes de datos — precipitacion, incendios y hielo marino

Este documento cubre exclusivamente los tres datasets preparados por
`scripts/prepare_precipitation.py`, `scripts/prepare_fires.py` y
`scripts/prepare_sea_ice.py`. No modifica ni depende de GISTEMP, del globo,
la UI ni del `manifest.json` compartido (esos archivos son responsabilidad
de otra tarea en curso). El indice propio de estos tres datasets es
`public/data/dj-index.json`.

## Estado actual: BLOQUEADO por autenticacion (sin datos reales publicados)

Las tres fuentes oficiales requieren registro/login gratuito de NASA
Earthdata (o un MAP_KEY de FIRMS) para descargar archivos originales. Esto
se verifico empiricamente (no por suposicion) el 2026-10-08 con peticiones
HTTP anonimas reales:

| Fuente | Comando de verificacion | Resultado real |
|---|---|---|
| IMERG (GES DISC) | `curl -sL -o /dev/null -w '%{http_code} %{url_effective}' "https://gpm1.gesdisc.eosdis.nasa.gov/data/GPM_L3/GPM_3IMERGM.07/2023/3B-MO.MS.MRG.3IMERG.20230101-S000000-E235959.01.V07B.HDF5"` | HTTP 401 inicial, redirige a `https://urs.earthdata.nasa.gov/oauth/authorize/...` (login OAuth NASA Earthdata) |
| FIRMS (API area) | `curl -s "https://firms.modaps.eosdis.nasa.gov/api/country/csv/0000000000000000000000000000000/MODIS_SP/PER/1"` | `Invalid API call.` (HTTP 400; requiere MAP_KEY valido) |
| NSIDC-0051 (HTTPS DAAC) | `curl -sL -o /dev/null -w '%{http_code} %{url_effective}' "https://daacdata.apps.nsidc.org/pub/DATASETS/NSIDC-0051/NSIDC-0051.002/2023.01.01/"` | HTTP 200 final, pero la URL efectiva es `https://urs.earthdata.nasa.gov/oauth/authorize?...` (login OAuth NASA Earthdata) |

Ninguno de estos requisitos se sorteo. Por instruccion explicita de la
tarea, no se registraron cuentas ni se solicitaron claves en nombre del
usuario. En consecuencia:

- **No existen archivos reales en `public/data/precipitation/`,
  `public/data/fires/` ni `public/data/sea-ice/`.**
- `public/data/dj-index.json` no se genero (los scripts solo lo escriben
  tras exportar al menos un mes real).
- Ningun dataset se declara "terminado".

Los tres scripts, al ejecutarse sin `--input*` y sin credenciales
disponibles, imprimen el bloqueo exacto por stderr (URL intentada, codigo
HTTP/mensaje, pagina oficial de registro) y terminan con codigo de salida 1
sin escribir ningun archivo de salida ni tocar el indice.

## Como destrabar cada fuente (acceso oficial, sin sortear nada)

### IMERG Final Run Monthly (GPM_3IMERGM.07)
1. Crear cuenta gratuita en https://urs.earthdata.nasa.gov/
2. En el perfil de Earthdata, autorizar la aplicacion "GES DISC" (requerido
   ademas del login).
3. Configurar `~/.netrc` segun https://disc.gsfc.nasa.gov/data-access
   (entrada para `machine urs.earthdata.nasa.gov`).
4. Ejecutar `python scripts/prepare_precipitation.py --year 2023 --month 1`
   (el script detecta `~/.netrc` y descarga automaticamente); o descargar
   manualmente el `.HDF5` desde
   https://disc.gsfc.nasa.gov/datasets/GPM_3IMERGM_07/summary y pasar
   `--input ruta/al/archivo.HDF5`.

### FIRMS (detecciones MODIS de archivo)
1. Solicitar un MAP_KEY gratuito en
   https://firms.modaps.eosdis.nasa.gov/api/map_key/
2. Exportar `FIRMS_MAP_KEY=<clave>` en el entorno.
3. Ejecutar `python scripts/prepare_fires.py --year 2023 --month 1` (el
   script llama a `/api/area/csv/` en tramos de hasta 10 dias para cubrir
   el mes, limitado al bbox Peru+Amazonia); o descargar manualmente un CSV
   de archivo desde https://firms.modaps.eosdis.nasa.gov/download/ (debe
   incluir la columna `type`) y pasar `--input ruta/al/archivo.csv`.

### NSIDC-0051 v2 (concentracion de hielo, NASA Team)
1. Mismo registro de Earthdata Login que IMERG (paso 1-3 arriba); no
   requiere autorizar una app adicional, basta el login NASA Earthdata
   estandar para `daacdata.apps.nsidc.org`.
2. Ejecutar
   `python scripts/prepare_sea_ice.py --year 2023 --month 1` (descarga
   automatica norte+sur si hay `~/.netrc`); o descargar manualmente los
   `.nc` de https://nsidc.org/data/nsidc-0051/versions/2 y pasar
   `--input-north ruta/norte.nc --input-south ruta/sur.nc` (se puede pasar
   solo uno de los dos; el hemisferio faltante queda `null`).

**Nota de fin de vida del dataset:** segun la guia de usuario oficial
(https://nsidc.org/sites/default/files/documents/user-guide/nsidc-0051-v002-userguide.pdf),
el productor de NSIDC-0051 dejo de procesar datos nuevos; la cobertura
final es del 26 de octubre de 1978 al 31 de diciembre de 2025 (estatico).
Enero y septiembre de 2023 estan dentro de ese rango.

## Modelo de datos comun (una vez haya archivos reales)

Rejilla geografica de 2 grados, 90 filas (lat, ascendente, -89..89 centros)
x 180 columnas (lon, ascendente, -179..179 centros), 16200 celdas, aplanado
fila-mayor (`indice = lat_idx * 180 + lon_idx`). `null` donde no hay dato o
no hay cobertura declarada. Cada JSON incluye: `dataset`, `variable`,
`period` (`AAAA-MM`), `units`, resolucion de rejilla fuente/destino,
metodo de agregacion/cobertura, `source` (pagina del dataset, URL exacta
del archivo, fecha de descarga UTC, sha256 del archivo original).

### Precipitacion (IMERG Final Run Monthly, `GPM_3IMERGM.07`)
- Variable fuente: grupo `Grid`, variable `precipitation` (tasa, **mm/h**;
  el script verifica el atributo `units` del NetCDF y aborta si no dice
  mm/h, para nunca mezclar tasa con acumulado mm/mes).
- Rejilla fuente: 0.1 grados (3600 lon x 1800 lat).
- Agregacion a 2 grados: promedio ponderado por area (`cos(lat)` de cada
  subcelda de 0.1 grados) de las 20x20 subceldas que caen en cada celda
  destino. Si menos del 50% de las subceldas tienen dato valido
  (`MIN_COVERAGE_FRACTION`), la celda destino es `null`.
- Unidad de salida: `mm/h` (tasa promedio mensual), nunca convertida a
  acumulado.

### Incendios (NASA FIRMS, MODIS Collection 6.1, archivo)
- Region declarada: bounding box Peru + Amazonia
  `[-82, -20, -45, 5]` (lon_oeste, lat_sur, lon_este, lat_norte).
- Filtros aplicados (documentados en el propio JSON de salida, campo
  `filters`): `confidence >= 30` (FIRMS recomienda excluir confianza baja
  para analisis cuantitativo) y `type == 0` ("presumed vegetation fire"),
  excluyendo volcanes activos, otras fuentes estaticas de calor y
  detecciones offshore.
- Valor de celda: **conteo de detecciones filtradas del mes** (no area
  quemada ni "incendios unicos"; una misma quema puede producir varias
  detecciones en distintos pasos del satelite).
- Dentro del bbox: conteo (puede ser 0, significa cobertura confirmada sin
  detecciones). Fuera del bbox: `null`.

### Hielo marino (NSIDC-0051 v2, NASA Team)
- Variable fuente: `<SENSOR>_ICECON` (para 2023, sensor DMSP-F17/SSMIS =>
  `F17_ICECON`; el script deriva el sensor correcto segun la fecha, Tabla 6
  de la guia de usuario).
- Valores 0..250 (bytes) => 0..100% de concentracion (factor 100/250).
  Flags 251 (pole hole), 252 (no usado), 253 (costa) y 254 (tierra) se
  **excluyen** del promedio (nunca se cuentan como 0%; la tierra nunca se
  marca como oceano sin hielo).
- Reproyeccion real: cada pixel fuente (25x25 km, proyeccion polar
  estereografica EPSG:3411 norte / EPSG:3412 sur, segun la propia guia de
  usuario) se transforma a lon/lat con `pyproj` antes de agregarlo a la
  rejilla de 2 grados.
- Agregacion: promedio simple de los pixeles oceanicos validos que caen en
  cada celda destino (todos los pixeles fuente tienen la misma area fisica
  de 25x25 km, por lo que el peso por area es uniforme dentro de esta
  fuente). Celdas destino sin ningun pixel oceanico valido son `null`.
- Unidad de salida: **fraccion 0.0-1.0** de area oceanica valida cubierta
  por hielo (campo `units` lo explicita).

## Indice propio: `public/data/dj-index.json`

Cada script actualiza unicamente su propia seccion (`precipitation`,
`fires` o `sea_ice`) dentro de `public/data/dj-index.json`, preservando las
demas secciones. Este archivo es independiente del `manifest.json`
compartido (que este conjunto de scripts no toca). Mientras no haya
archivos reales exportados, `dj-index.json` no existe.

## Pruebas (`tests/dj-data/`)

Las pruebas en `tests/dj-data/` usan **fixtures sinteticos construidos en
el propio test** (CSV y NetCDF de juguete), no datos reales de NASA, para
verificar: escalado y ponderacion por `coslat` (precipitacion), filtros de
confianza/tipo/bbox/mes y conteo por celda (incendios), y decodificacion de
flags + reproyeccion EPSG:3411→EPSG:4326 (hielo marino). Ejecutar con:

```
python -m pytest tests/dj-data -v
```

No se declara ninguna prueba como "comparacion contra datos reales" porque,
al momento de escribir esto, no hay ningun archivo original real
descargado (ver seccion de bloqueo arriba). Si en el futuro se obtiene un
archivo real via `--input*`, se puede extender `tests/dj-data/` con una
comparacion celda a celda contra el archivo original siguiendo el mismo
patron que `tests/gistemp-export.test.js` (lectura independiente del
original + comparacion de al menos 5 celdas), mencionada aqui solo como
referencia de patron, sin reclamar que ya exista para estos tres datasets.
