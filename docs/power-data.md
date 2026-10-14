# Precipitacion NASA POWER (PRECTOTCORR / MERRA-2) — 3 puntos Peru

Preparador: `scripts/prepare_power.py`. Salida: `public/data/power/*.json`
(uno por punto) + `public/data/power-index.json`. Cache crudo propio en
`work/raw-power/` (no compartido con otros preparadores).

## Fuente

- Servicio: **NASA POWER** (Prediction Of Worldwide Energy Resource),
  endpoint "Monthly and Annual", consulta por punto.
  - Documentacion del servicio:
    https://power.larc.nasa.gov/docs/services/api/temporal/monthly/
  - Metodologia / resolucion nativa MERRA-2:
    https://power.larc.nasa.gov/docs/methodology/meteorology/
- Parametro: `PRECTOTCORR` ("Precipitation Corrected").
- Producto origen declarado por la propia respuesta
  (`header.sources`): `MERRA2` (reanalisis GMAO MERRA-2).
- Unidades reales devueltas por la API (`parameters.PRECTOTCORR.units`):
  **`mm/day`**.
- **Importante sobre la magnitud**: cada valor mensual es el **promedio de
  la tasa diaria de precipitacion de ese mes**, NO un total acumulado
  mensual y NO un producto IMERG. No se debe sumar los 12 valores de un
  anio para obtener un "total anual en mm": eso requeriria multiplicar cada
  mes por sus dias y sumar, operacion que este preparador NO realiza (se
  exporta el dato tal cual lo entrega la API).
- Resolucion nativa de la fuente (MERRA-2), segun la documentacion de
  metodologia de NASA POWER: rejilla espacial de **0.5° latitud x 0.625°
  longitud**, con datos fuente horarios agregados a mensual por el propio
  servicio POWER. El punto efectivo que la API realmente resuelve (snap a
  su rejilla) se guarda en `coords_effective` de cada JSON, junto con la
  elevacion que la propia API reporta para esa celda.
- Version de servicio observada en las respuestas: `header.api.version`
  = `v2.10.0` (se guarda en cada JSON exportado, no se asume fija).
- `fill_value` declarado por la API (`header.fill_value`): `-999.0`. Este
  preparador mapea ese valor a `null` en el JSON exportado; nunca lo
  confunde con `0` (cero precipitacion real).

## Puntos cubiertos

| location_id | nombre                              | lat    | lon    |
|-------------|-------------------------------------|--------|--------|
| iquitos     | Iquitos (selva amazonica, Peru)     | -3.75  | -73.25 |
| quelccaya   | Glaciar Quelccaya (Andes, Peru)     | -13.93 | -70.82 |
| mar-piura   | Oceano frente a Piura, Peru         | -5.00  | -81.50 |

Las coordenadas son aproximadas (puntos representativos), no observacion
directa de superficie: MERRA-2 es un reanalisis de modelo, no una red de
estaciones. El preparador NO extrapola fuera de la cobertura que la propia
API devuelve para cada punto.

## Cobertura temporal obtenida

Se probo pedir directamente `start=2000&end=2025` (mismo rango que el
dataset GISTEMP ya preparado en este proyecto) para los 3 puntos. La API
**acepto el rango completo en una sola solicitud por punto**, sin devolver
error de limite ni necesidad de dividir en sub-periodos:

- Cada respuesta cruda contiene 338 claves (26 anios x 13: 12 meses +
  1 promedio anual `YYYY13`).
- Tras excluir las 26 claves `YYYY13` (promedio anual, no un mes), cada
  JSON exportado tiene **312 meses**, de **2000-01 a 2025-12**, **sin
  ningun valor `null`** en los 3 puntos (cobertura completa, verificado en
  las 3 respuestas).

El script incluye una division de respaldo por bloques de anios
(`YEAR_BLOCK_SIZE_FALLBACK`) en el codigo, pero **no se activo** en esta
preparacion porque no hizo falta.

## Acceso: solo 1 solicitud concurrente, cache y reintentos

- Las 3 ubicaciones se procesan **secuencialmente** (nunca en paralelo),
  con una pausa de `SLEEP_BETWEEN_REQUESTS_SECONDS` (2s) entre puntos.
- No se encontro en la documentacion oficial de NASA POWER un limite de
  tasa (`rate limit`) explicito para este endpoint; la unica mencion
  relevante es que el servicio puede responder `429 Too Many Requests`
  bajo carga. Por eso el script reintenta con backoff fijo (hasta
  `MAX_RETRIES=3`, esperando `RETRY_BACKOFF_SECONDS=5` entre intentos) solo
  ante errores transitorios (`429`, `5xx`, timeout/conexion); un error
  `4xx` distinto de `429` se propaga de inmediato (no se reintenta un error
  de solicitud mal formada).
- Cache local en `work/raw-power/<location_id>_<start>-<end>.json`: si ya
  existe, se reutiliza sin volver a pedir a la API. Usar `--refresh` para
  forzar una nueva descarga (por punto completo, no por mes).
- `--locations <id> [<id> ...]` permite procesar un subconjunto de los 3
  puntos (util para refrescar uno solo).

## Formato de cada `public/data/power/<location_id>.json`

Campos principales: `location_id`, `name`, `coords_requested`,
`coords_effective` (incluye `elevation_m` reportado por la API),
`parameter`, `quantity_kind`, `units`, `source` (servicio, producto,
version, URL exacta usada), `dataset_native_resolution` (resolucion de la
fuente, citada de la documentacion, no inventada), `fill_value_raw`,
`period_start`/`period_end`/`period_count`, `null_count`, `monthly`
(mapeo `"YYYY-MM" -> numero | null`), `downloaded_date_utc` y
`original_response_sha256` (checksum de la respuesta cruda cacheada).

## `public/data/power-index.json`

Lista las 3 ubicaciones realmente presentes en `public/data/power/`
(releido del disco, no de una lista en memoria), con sus coordenadas
pedidas/efectivas, ruta, rango de periodos real y tamano de archivo. Se
regenera por completo en cada ejecucion del script a partir de lo que
exista en disco, para no desincronizarse de los datos.

## Pruebas manuales realizadas

Para cada uno de los 3 puntos se comparo, contra el JSON crudo cacheado en
`work/raw-power/`, una muestra aleatoria de **5 periodos mensuales**
(`YYYY-MM`), confirmando: (a) el valor exportado coincide exactamente con
el valor crudo cuando no es el `fill_value`; (b) ninguna clave `YYYY-13`
(promedio anual) aparece en el `monthly` exportado; (c) el checksum
`original_response_sha256` coincide con el SHA-256 real del archivo
cacheado. Tambien se verifico el tamano de cada archivo de salida (~6 KB,
JSON ligero) y se confirmo que una segunda ejecucion sin `--refresh` no
vuelve a llamar a la API (reutiliza el cache) y que `--refresh
--locations <id>` solo toca el archivo crudo de esa ubicacion, sin alterar
los otros dos ni perder sus entradas en el indice.

## Opciones de acceso para puntos NO precargados (fuera de los 3 puntos)

Este preparador **no promete cobertura offline completa del planeta**: solo
deja listos estos 3 puntos peruanos. Para un clic futuro del usuario en
cualquier otro punto del globo, el frontend (otra tarea, no implementada
aqui) puede:

1. Resolver la celda efectiva mas cercana consultando en vivo el mismo
   endpoint `https://power.larc.nasa.gov/api/temporal/monthly/point` con
   `latitude`/`longitude` del clic y el (o los) anio(s) que el usuario
   seleccione, aplicando el mismo corte mensual (excluir `YYYY13`,
   mapear `fill_value` a `null`) que usa este script.
2. Cachear esa respuesta por **celda efectiva** (la API hace "snap" del
   punto pedido a su rejilla nativa de 0.5° x 0.625°; dos clics distintos
   dentro de la misma celda deberian compartir cache, usando
   `coords_effective` devuelto por la API como clave, no las coordenadas
   pedidas por el usuario).
3. Nunca mostrar el promedio anual (`YYYY13`) como si fuera un mes, y
   nunca presentar `mm/day` como si fuera un total mensual sin aclararlo.

No se implementa aqui ninguna UI ni logica de repositorio para ese flujo
en vivo: queda documentado como opcion para la tarea que sí toca la UI/el
globo.
