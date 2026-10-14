# Metodo cientifico (resumen GISTEMP)

Earth Jukebox usa el analisis GISTEMP v4 de NASA GISS como primera fuente de
datos climaticos. Resumen del metodo (ver detalle completo en la pagina del
dataset: https://data.giss.nasa.gov/gistemp/):

- GISTEMP combina observaciones de estaciones terrestres (GHCNv4) con
  temperatura superficial del mar (ERSSTv5) para estimar anomalias de
  temperatura mensuales respecto a un periodo base (baseline).
- La anomalia (no la temperatura absoluta) se calcula porque es mas estable
  espacialmente: permite interpolar/suavizar razonablemente entre estaciones
  distantes.
- El periodo base usado en el archivo consumido por este proyecto es
  **1951-1980**.
- Para producir una rejilla continua, GISTEMP aplica un suavizado espacial
  con radio de **1200 km**, es decir, cada celda de la rejilla refleja la
  influencia de estaciones/observaciones dentro de ese radio.
- La rejilla resultante distribuida en NetCDF tiene resolucion de **2
  grados** (90 x 180 celdas), con los ejes lat/lon representando centros de
  celda.
- Las celdas sin suficiente dato cercano quedan marcadas como ausentes
  (`_FillValue` en el NetCDF original, `null` en el JSON exportado por este
  proyecto) en vez de rellenarse con un valor inventado.

## Decisiones tecnicas de esta implementacion

- La decodificacion de `scale_factor` y `_FillValue` se delega por completo a
  la libreria `netCDF4` (modo "auto mask and scale", activado por defecto),
  evitando aplicar el factor de escala dos veces.
- No se reproyecta ni reinterpola la rejilla: se exporta la rejilla original
  de 2 grados tal como viene en el NetCDF fuente.
- El indice temporal del mes solicitado se busca por fecha decodificada
  (`cftime`/`num2date`), no por un indice fijo asumido, para evitar errores
  silenciosos si el archivo fuente cambia su rango temporal.

## Precipitacion (NASA POWER PRECTOTCORR/MERRA-2) y EIC anual (fase 5-6)

- `PRECTOTCORR` es el **promedio de la tasa diaria mensual** (mm/dia) de un
  reanalisis (MERRA-2), no una observacion satelital directa ni un total
  acumulado; nunca se presenta como "mm de lluvia del mes" sin esa
  aclaracion (ver `docs/power-data.md` y los textos `djUnitsNote`/
  `djRainApi`/`djRainLocal` en `src/i18n/`). Es un producto DISTINTO de GPM
  IMERG (que si mide precipitacion por satelite); ninguna capa de este
  proyecto declara que ambos son "la misma medicion".
- El panel "Recursos EIC" sonifica el promedio **GLOBAL ANUAL** de GISTEMP
  (+1.19 °C en 2025), no la celda local ni un pixel de la imagen del mapa
  NASA SVS: son dos agregaciones espaciales distintas del mismo dataset/
  baseline (ver `docs/eic-integration.md`). El dato es un snapshot de una
  publicacion oficial de NASA (no el CSV vivo) y puede revisarse mas
  adelante; eso se muestra explicitamente en la UI (`eicRevisionWarning`),
  no se oculta.
- Incendios (NASA FIRMS) y hielo marino (NSIDC) tienen un mapeo matematico
  puro ya implementado y probado (`src/audio/mixer.js`,
  `tests/mixer.test.js`), pero sin datos reales locales: ambas fuentes
  exigen autenticacion NASA Earthdata que esta entrega no sortea (ver
  `docs/dj-data-sources.md`). La UI los muestra deshabilitados, nunca
  simulados con datos inventados.
