# Integracion con un recurso oficial del Earth Information Center (EIC)

Version final y corta de esta investigacion. Reemplaza la version anterior
(que recomendaba la espiral SVS 5190 como fondo "ilustrativo"): ese recurso
se descarta aqui porque no tiene un mapeo frame->fecha verificable y no es
necesario — hay un mapa anual estatico que calza mejor.

## 1. Recurso EIC elegido

**Mapa anual GISTEMP 2025** — NASA Scientific Visualization Studio (SVS)

- Pagina: https://svs.gsfc.nasa.gov/5603/ ("Global Temperature Anomalies
  from 1880 to 2025"), con la etiqueta "Earth Information Center" en sus
  metadatos.
- Frame verificado: https://svs.gsfc.nasa.gov/vis/a000000/a005600/a005603/Map_HD_2025.png
  (HTTP 200, 1 275 529 bytes, 1920x1080, `Last-Modified: 2026-01-12`,
  variante "spatially smoothed", **sin** promedio temporal de 12/24 meses —
  es un mapa de un solo anio calendario, 2025).
- Baseline: 1951-1980 (mismo que usa ya este proyecto en
  `public/data/gistemp/*.json`).
- **2024 (SVS 5450) queda excluido a proposito**: su unico contenido es un
  video/imagen cuyo frame final es el promedio movil de 24 meses que
  termina en 2024, no un mapa de un solo anio calendario. No es la misma
  construccion estadistica que el mapa 2025, asi que no se declara
  equivalente.
- **La espiral mensual (SVS 5190) ya no se recomienda**: no existe
  manifiesto oficial frame->mes publicado por NASA, por lo que sincronizarla
  con un dato mensual/anual especifico seria una suposicion, no un hecho
  verificado.

## 2. Numero global anual usado (2025)

- **Bloqueo de red**: la descarga de la tabla oficial
  `https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv` (ya
  verificada como HTTP 200 en una sesion anterior) fallo repetidamente por
  timeouts de conexion al preparar esta entrega (otros hosts de NASA, como
  `svs.gsfc.nasa.gov`, respondieron normalmente). No se forzaron mas
  reintentos largos.
- En su lugar se usa un **snapshot numerico de una publicacion oficial ya
  existente**, no un valor inventado ni leido de la imagen:
  - https://www.nasa.gov/news-release/nasa-releases-global-temperature-data/
    ("NASA Releases Global Temperature Data", release 26-003, publicado
    14 de enero de 2026; copia cruda guardada en
    `work/raw-eic/nasa_pr_2025_global_temp.html`).
  - Version en espanol: https://www.nasa.gov/news-release/la-nasa-publica-datos-de-la-temperatura-global/
  - Texto citado verificado: *"Global temperatures in 2025 were cooler than
    2024, with average temperatures of 2.14 degrees Fahrenheit (**1.19
    degrees Celsius**) above the 1951 to 1980 average."*
  - Esta fecha de publicacion (14 ene 2026) coincide con la ventana en que
    se genero el frame del mapa (`Last-Modified` 12 ene 2026): ambos vienen
    del mismo ciclo de actualizacion de GISTEMP.

## 3. Que representa cada parte (coincidencia cientifica declarada)

- El **frame** es un mapa espacial: anomalia de temperatura por celda de
  rejilla para el anio 2025, mismo dataset/baseline que el proyecto.
- El **sonido/indicador** es el **promedio GLOBAL ANUAL** (+1.19 °C) del
  mismo dataset, mismo anio, mismo baseline — **no** es el valor de la celda
  donde el usuario hace clic, ni una lectura de color de la imagen. Se
  declara explicitamente como un indicador agregado, no un dato local.
- Este panel es una **demostracion anual adicional**; no reemplaza el modo
  mensual/rejilla local 2000-2025 que ya usa el proyecto.
- No hay sincronizacion de video/espiral: el frame es estatico.

## 4. Advertencia de revision de datos

GISTEMP revisa sus resultados cuando llegan datos de estaciones nuevos o
corregidos. El valor +1.19 °C es el que NASA publico en enero de 2026 junto
con este mismo mapa; una version futura de la tabla CSV (p. ej. actualizada
en septiembre/octubre 2026) podria diferir ligeramente si GISTEMP revisó
2025 despues. Esto se documenta en `eic-annual.json` (`revision_warning`),
no se oculta ni se corrige automaticamente.

## 5. Archivos de esta entrega

- `public/data/eic-annual.json`: snapshot verificado (2025 unicamente),
  con `numeric_provenance` explicito (tipo "nasa_publication_snapshot", no
  CSV) y `csv_fallback` documentando que el script de CSV existe pero no se
  ejecuto en esta corrida.
- `public/data/eic-resource.json`: metadatos de atribucion/URLs del mapa
  2025 (ya no de la espiral).
- `scripts/prepare_eic_annual.py`: preparador para cuando la descarga del
  CSV funcione; parsea el encabezado real por nombre de columna (`J-D`), no
  por indice fijo. No se promete una actualizacion automatica futura.
- `work/raw-eic/nasa_pr_2025_global_temp.html`: copia cruda de la pagina
  fuente del numero usado.

## 6. Limites explicitos

- No se leyeron pixeles de ninguna imagen para obtener valores numericos.
- No se descargaron imagenes ni videos de SVS a este repositorio; el
  frontend debe usar `<img>` remoto apuntando a la URL oficial.
- Solo 2025 tiene frame anual + numero verificados juntos; 2024 queda
  explicitamente excluido (seccion 1).
- El valor 2025 es un snapshot de publicacion, no el CSV vivo: si se
  requiere el dato CSV exacto mas adelante, ejecutar
  `scripts/prepare_eic_annual.py` cuando la red lo permita y comparar contra
  este snapshot antes de sustituirlo.
