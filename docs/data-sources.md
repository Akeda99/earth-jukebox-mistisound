# Fuentes de datos

## GISTEMP (NASA GISS) — anomalia de temperatura superficial

- Pagina del dataset: https://data.giss.nasa.gov/gistemp/
- Archivo NetCDF usado: https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz
- Version: GISTEMP v4, combinando GHCNv4 (estaciones terrestres) y ERSSTv5 (temperatura superficial del mar)
- Resolucion de rejilla: 2 x 2 grados (90 lat x 180 lon), ejes como centros de celda
- Radio de suavizado espacial: 1200 km
- Periodo base (baseline) de la anomalia: 1951-1980
- Variable usada: `tempanomaly` (anomalia de temperatura). La unidad **se lee
  del atributo `units` del NetCDF en cada ejecucion** (no se asume "K" ni
  "degC" en el codigo); en la version actual del archivo fuente es `K`.
  Nota de equivalencia: una anomalia expresada en Kelvin y la misma
  anomalia expresada en grados Celsius tienen **igual magnitud**, porque
  son diferencias de temperatura (delta), no temperaturas absolutas; solo
  cambia el nombre de la unidad, no el numero.
- Orden de dimensiones en el NetCDF original: `(time, lat, lon)`, lat y lon ascendentes
- Valores ausentes: marcados con `_FillValue` en el NetCDF original; exportados como `null` en el JSON (nunca como 0)

## Descarga y preparacion

El archivo original (`gistemp1200_GHCNv4_ERSSTv5.nc.gz`, ~25 MB comprimido) se descarga a
`work/raw/` dentro del proyecto (carpeta ignorada por git). El script
`scripts/prepare_gistemp.py --start-year 2000 --end-year 2025`:

1. Descarga el `.nc.gz` **una sola vez** (o usa un archivo local pasado con
   `--input`); si ya existe en `work/raw/`, lo reutiliza en vez de volver a
   descargarlo.
2. Lo descomprime **una sola vez** (si el `.nc` ya existe, no se vuelve a
   descomprimir) y lo abre **una sola vez** con `netCDF4`, dejando que la
   libreria aplique una sola vez por mes el `scale_factor` y el enmascarado
   de `_FillValue` (no se reaplica manualmente ningun factor de escala).
3. Calcula el checksum SHA-256 del archivo original **una sola vez** por
   ejecucion (no una vez por mes exportado).
4. Verifica el orden de dimensiones `(time, lat, lon)`, que lat/lon estan en
   orden ascendente, que la rejilla es de 90x180 celdas (2 grados) y lee la
   unidad real desde el atributo `units` del NetCDF.
5. Para cada mes del rango pedido (por defecto 2000-01 a 2025-12) que
   exista en la variable `time` del NetCDF (busqueda por fecha decodificada,
   no por indice fijo) y que no quede completamente vacio, exporta un JSON
   compacto (sin espacios ni `NaN`/`Infinity`; `allow_nan=False`) en
   `public/data/gistemp/AAAA-MM.json` con:
   - `axes.lat_centers` / `axes.lon_centers`: centros de celda de la rejilla original
   - `values`: arreglo plano en orden fila-mayor (`indice = lat_idx * n_lon + lon_idx`)
   - `null` para celdas sin dato original (nunca 0 ni un valor extrapolado)
   - metadatos: unidad real leida del NetCDF (+ nota de equivalencia K/°C),
     baseline, suavizado, resolucion, periodo, version del dataset, URL de
     origen, fecha de descarga y checksum SHA-256 del archivo original
   - meses fuera del rango cubierto por el NetCDF fuente, o cuya rejilla
     resultaria completamente vacia, se omiten (se avisa por stderr) en vez
     de generar un archivo incompleto o simulado
6. Regenera `public/data/manifest.json` listando unicamente los archivos
   JSON que realmente existen en `public/data/gistemp/`, con su `period` y
   `path` reales parseados del propio nombre de archivo.

Si el archivo fuente no esta disponible, si ningun mes del rango pedido
existe en el NetCDF, o si la estructura de dimensiones/unidades no es la
esperada, el script falla con un error en vez de generar datos simulados o
incompletos.

## Formato del JSON exportado (ejemplo: `gistemp/2023-01.json`)

```json
{
  "dataset": "GISTEMP v4 (GHCNv4 land + ERSSTv5 ocean)",
  "variable": "tempanomaly",
  "period": "2023-01",
  "units": "K",
  "units_note": "Anomalia (delta de temperatura), no temperatura absoluta: la misma magnitud en K que en grados Celsius.",
  "baseline_period": "1951-1980",
  "smoothing_radius_km": 1200,
  "grid_resolution_deg": 2,
  "grid_shape": { "lat": 90, "lon": 180 },
  "value_order": "row-major: fila=lat (ascendente), columna=lon (ascendente); indice = lat_idx * n_lon + lon_idx",
  "axes": { "lat_centers": [...], "lon_centers": [...] },
  "null_count": 67,
  "cell_count": 16200,
  "values": [...],
  "source": {
    "dataset_page": "https://data.giss.nasa.gov/gistemp/",
    "file_url": "https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz",
    "download_date_utc": "...",
    "original_file_sha256": "..."
  }
}
```

## Formato de `public/data/manifest.json`

```json
{
  "generated_utc": "...",
  "files": [
    { "period": "2000-01", "path": "gistemp/2000-01.json", "size_bytes": 89292 }
  ]
}
```

El repositorio del front-end (`src/data/repository.js`) usa el campo
`period` de cada entrada para saber que periodos existen realmente y
resolver vecinos (mes anterior/siguiente) sin asumir ningun mes que no
este listado aqui.

## Ampliacion a la serie completa 1880-01 a 2026-08 (tarea 15)

- Se re-exporto con `scripts/prepare_gistemp.py --input work/raw/gistemp1200_GHCNv4_ERSSTv5.nc.gz --start-year 1880 --end-year 2026`
  desde el **mismo archivo original ya descargado** (SHA-256
  `6a597332bcefbe0fbe5a6ce7677a9012fa766cc43cea291d6207c12db2fe0cc6`,
  descargado 2026-10-09). No se forzo una fuente nueva.
- El NetCDF tiene 1760 meses, de 1880-01-15 a 2026-08-15. El manifiesto
  ahora lista 1760 archivos (`public/data/gistemp/YYYY-MM.json`, 155 945 796
  bytes en total, ~153 MB sin comprimir) y el **ultimo periodo real es
  2026-08**. La app lo muestra con su fecha exacta ("agosto de 2026"), nunca
  como "hoy".
- Las celdas sin dato (`null`) se conservan; las epocas antiguas tienen
  muchas. Un `null` nunca se muestra como 0 ni se sonifica.
- Verificacion independiente: `tests/gistemp-history-epochs.test.js` relee el
  NetCDF original con netCDF4 y compara celdas de 5 epocas (1880-01, 1950-06,
  1990-01, 2010-07, 2026-08), incluida al menos una celda `null`, y comprueba
  el SHA original y los 1760 periodos del manifiesto.

## Catalogo de ciudades GeoNames (tarea 15)

- Fuente: GeoNames `cities15000.zip` (https://download.geonames.org/export/dump/),
  licencia **Creative Commons Attribution 4.0**; credito "GeoNames
  (geonames.org)" visible en la app y en el JSON.
- SHA-256 del zip descargado: `2fb16be8fede1f2c4b5d506517106fedf16e9e3d16b2e1c6b8f52c96ea7aa673`
  (fecha de preparacion registrada en `prepared_utc` dentro del JSON).
- `scripts/prepare_geonames.py` genera `public/data/geonames-cities.json`:
  34 162 ciudades, 2 899 035 bytes, filas `[id, nombre, pais, lat, lon, poblacion, claves]`
  con claves sin acentos. Se descarga **solo** al primera busqueda (lazy) y la
  busqueda es local: ningun servicio externo recibe la ciudad ni la fecha.
- Limitaciones: ciudades de 15 000 habitantes o mas; si el pueblo no esta, se
  usa el punto del globo o coordenadas. Hay nombres repetidos entre paises: la
  lista muestra pais y coordenadas.
