#!/usr/bin/env python3
"""Genera public/data/eic-annual.json: indicador GLOBAL ANUAL de GISTEMP v4
(columna J-D de la tabla anual oficial), emparejado con mapas anuales
ESTATICOS del Earth Information Center (NASA SVS) que representan ese mismo
anio y el mismo baseline.

Fuente numerica (tabla anual, NO rejilla):
  https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv

Este script:
  1. Descarga el CSV UNA SOLA VEZ (o usa --input con un archivo local ya
     descargado) a work/raw-eic/, reutilizandolo si ya existe.
  2. Calcula su checksum SHA-256 una sola vez.
  3. Parsea el encabezado REAL del CSV (no se asume la posicion de la
     columna "J-D": se busca por nombre en la fila de encabezado) para
     ubicar la columna de anomalia global anual.
  4. Para cada anio pedido en --years, lee el valor "J-D" de esa fila. Si la
     celda es "***" (anio incompleto en la fuente) o no existe esa fila, el
     anio se omite (aviso por stderr), nunca se inventa un valor.
  5. Solo incluye en la salida los anios para los que ADEMAS existe un frame
     oficial de SVS verificado como mapa ANUAL (no promedio movil de 24
     meses, no espiral sin mapeo documentado) del MISMO anio y MISMO
     baseline. Esa lista de frames verificados esta fija en
     VERIFIED_ANNUAL_FRAMES (ver comentario junto a la constante: cada URL
     fue confirmada con una peticion HTTP real, no adivinada).
  6. Escribe public/data/eic-annual.json con, por cada anio incluido: el
     valor numerico J-D (unidades = las que declara el propio CSV, anomalia
     en grados Celsius segun la cabecera de GISTEMP v4), el baseline, la
     URL de pagina SVS, la URL exacta del frame, resolucion, tamano en bytes
     y fecha Last-Modified del frame (verificados por HTTP), y metadatos de
     procedencia del CSV (URL, fecha de descarga, checksum SHA-256).

No se promedia la rejilla espacial con o sin pesos de area aqui: el valor
sonificado es el agregado GLOBAL ANUAL que ya publica NASA GISS en la propia
tabla (columna J-D), no un promedio casero de celdas. Tampoco se sustituye
ningun valor de celda local por este global: este archivo es un recurso
aparte (eic-annual.json), no reemplaza public/data/gistemp/*.json.

Advertencia de version: GISTEMP revisa sus resultados cuando llegan datos de
estaciones nuevos o corregidos. El frame de SVS para un anio dado se generó
y publicó en una fecha especifica (ver "frame_last_modified_utc" por anio en
la salida); el valor numerico de este script se lee del CSV vigente en el
momento de ejecutar el script (ver "csv_download_date_utc"). Ambos pueden
diferir ligeramente si GISTEMP revisó el dato despues de publicado el frame.
Este script no corrige ni armoniza esa diferencia: solo la documenta.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCE_CSV_URL = "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv"
SOURCE_DATASET_PAGE = "https://data.giss.nasa.gov/gistemp/"
DATASET_VERSION = "GISTEMP v4 (GHCNv4 land + ERSSTv5 ocean)"
BASELINE_PERIOD = "1951-1980"
ANNUAL_COLUMN_NAME = "J-D"
MISSING_MARKER = "***"

ROOT = Path(__file__).resolve().parent.parent
WORK_RAW_DIR = ROOT / "work" / "raw-eic"
RAW_CSV_PATH = WORK_RAW_DIR / "GLB.Ts+dSST.csv"
OUT_PATH = ROOT / "public" / "data" / "eic-annual.json"

# Cada entrada aqui fue verificada manualmente con una peticion HTTP real
# (GET/HEAD) a la URL exacta del frame, el 2026-10-09, confirmando que:
#   (a) la pagina SVS describe ese frame como un mapa de UN SOLO anio
#       (no un promedio movil de 24 meses, no una espiral sin mapeo
#       frame->fecha documentado), con el mismo baseline 1951-1980;
#   (b) la URL del archivo de imagen responde HTTP 200.
# NO se agregan anios aqui sin repetir esa verificacion manual primero.
# 2024 (svs.gsfc.nasa.gov/5450/) se evaluo y se EXCLUYE a proposito: todas
# las imagenes/videos de esa pagina son el frame final de un promedio movil
# de 24 meses ("The maps are averages over a running 24 month window. The
# final frame represents global temperature anomalies in 2024."), que no es
# la misma construccion estadistica que el mapa 2025 (sin promedio
# temporal) y por lo tanto no se declara como mapa anual equivalente.
VERIFIED_ANNUAL_FRAMES = {
    2025: {
        "page_url": "https://svs.gsfc.nasa.gov/5603/",
        "page_title": "Global Temperature Anomalies from 1880 to 2025",
        "frame_url": "https://svs.gsfc.nasa.gov/vis/a000000/a005600/a005603/Map_HD_2025.png",
        "frame_caption": (
            "2025 global surface air temperature anomalies relative to a "
            "baseline period of 1951-1980. In this version, the dataset is "
            "spatially smoothed (no 12-month temporal averaging). Robinson "
            "projection, colormap 'vik' (Crameri, 2018)."
        ),
        "frame_resolution": "1920x1080",
        "frame_content_length_bytes": 1275529,
        "frame_last_modified_utc": "2026-01-12T20:28:58Z",
        "frame_verified_http_status": 200,
        "frame_verified_date_utc": "2026-10-09",
        "eic_tag_verified": True,
        "credits": [
            {"role": "Scientist", "name": "Gavin A. Schmidt", "affiliation": "NASA/GSFC GISS"},
            {"role": "Visualizer", "name": "Mark SubbaRao", "affiliation": "NASA/GSFC"},
        ],
    },
}

# 2024 queda documentado explicitamente como EXCLUIDO (no como "pendiente"),
# para que quede claro por que no aparece en VERIFIED_ANNUAL_FRAMES ni en la
# salida, sin tener que releer este comentario cada vez.
EXCLUDED_YEARS_NOTE = {
    2024: (
        "svs.gsfc.nasa.gov/5450/: unico contenido disponible es un video/"
        "imagen cuyo frame final es un promedio movil de 24 meses que "
        "termina en 2024, no un mapa de anomalia de un solo anio calendario "
        "como el de 2025 (5603). No se declara equivalente cientifico."
    ),
}


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_csv(input_arg: str | None) -> tuple[Path, str]:
    """Devuelve (ruta_csv, fecha_descarga_iso). Descarga a lo sumo una vez
    por ejecucion; reutiliza el archivo si ya existe en work/raw-eic/."""
    if input_arg:
        path = Path(input_arg).resolve()
        if not path.exists():
            raise FileNotFoundError(f"Archivo de entrada no encontrado: {path}")
        download_date = datetime.fromtimestamp(
            path.stat().st_mtime, tz=timezone.utc
        ).isoformat()
        print(
            f"Usando CSV local provisto: {path} "
            f"(fecha de descarga desconocida; se usa mtime: {download_date})",
            file=sys.stderr,
        )
        return path, download_date

    WORK_RAW_DIR.mkdir(parents=True, exist_ok=True)
    if RAW_CSV_PATH.exists():
        print(f"Reutilizando CSV ya descargado: {RAW_CSV_PATH}", file=sys.stderr)
        download_date = datetime.fromtimestamp(
            RAW_CSV_PATH.stat().st_mtime, tz=timezone.utc
        ).isoformat()
        return RAW_CSV_PATH, download_date

    print(f"Descargando {SOURCE_CSV_URL} -> {RAW_CSV_PATH}", file=sys.stderr)
    req = urllib.request.Request(
        SOURCE_CSV_URL, headers={"User-Agent": "earth-jukebox-prepare-script/1"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw_bytes = resp.read()
    with open(RAW_CSV_PATH, "wb") as out:
        out.write(raw_bytes)
    download_date = datetime.now(timezone.utc).isoformat()
    return RAW_CSV_PATH, download_date


def parse_annual_values(csv_path: Path) -> dict[int, float | None]:
    """Parsea el CSV real de GISTEMP (formato GLB.Ts+dSST.csv): una fila de
    encabezado con nombres de columna (entre ellas 'Year' y 'J-D'), seguida
    de filas de datos por anio. Encuentra la columna 'J-D' POR NOMBRE, no
    por indice fijo, para no depender de que el formato nunca cambie.

    GISTEMP suele repetir el encabezado mas abajo en el mismo archivo (bloque
    adicional, p.ej. con medias moviles); se usa SOLO la primera tabla cuyo
    encabezado contiene 'Year' y 'J-D', que es la tabla anual principal.
    """
    text = csv_path.read_text(encoding="utf-8", errors="strict")
    reader = csv.reader(io.StringIO(text))

    header_idx = None
    header_row = None
    rows = list(reader)
    for i, row in enumerate(rows):
        if "Year" in row and ANNUAL_COLUMN_NAME in row:
            header_idx = i
            header_row = row
            break

    if header_row is None:
        raise ValueError(
            f"No se encontro una fila de encabezado con 'Year' y "
            f"'{ANNUAL_COLUMN_NAME}' en {csv_path}; formato inesperado."
        )

    year_col = header_row.index("Year")
    jd_col = header_row.index(ANNUAL_COLUMN_NAME)

    values: dict[int, float | None] = {}
    for row in rows[header_idx + 1 :]:
        if len(row) <= max(year_col, jd_col):
            continue
        year_cell = row[year_col].strip()
        if not year_cell.isdigit():
            # Fin de la tabla anual (siguiente bloque/encabezado/pie de
            # pagina): se detiene en vez de seguir leyendo filas ajenas.
            break
        year = int(year_cell)
        cell = row[jd_col].strip()
        if cell == MISSING_MARKER or cell == "":
            values[year] = None
        else:
            values[year] = float(cell)
    return values


def build_eic_annual(
    years: list[int],
    annual_values: dict[int, float | None],
    csv_url: str,
    csv_checksum: str,
    csv_download_date: str,
) -> dict:
    entries = []
    skipped = []
    for year in years:
        frame = VERIFIED_ANNUAL_FRAMES.get(year)
        if frame is None:
            reason = EXCLUDED_YEARS_NOTE.get(
                year, "no hay frame SVS anual verificado para este anio"
            )
            skipped.append(f"{year} (sin frame verificado: {reason})")
            continue
        value = annual_values.get(year)
        if value is None:
            skipped.append(f"{year} (CSV marca '{MISSING_MARKER}' o anio ausente)")
            continue
        entries.append(
            {
                "year": year,
                "global_annual_anomaly": round(value, 4),
                "units": "deg C",
                "baseline_period": BASELINE_PERIOD,
                "dataset": DATASET_VERSION,
                "representation_note": (
                    "El frame es un mapa espacial de la anomalia anual; el "
                    "sonido/indicador es el promedio GLOBAL ANUAL del mismo "
                    "dataset y mismo anio/baseline (columna J-D), no el valor "
                    "de una celda especifica ni una lectura de color de la "
                    "imagen."
                ),
                "frame": frame,
            }
        )
    if skipped:
        print("Anios omitidos: " + "; ".join(skipped), file=sys.stderr)
    if not entries:
        raise ValueError(
            "Ningun anio del rango pedido tiene a la vez valor CSV valido y "
            "frame SVS verificado; no se genera un archivo vacio/simulado."
        )
    return {
        "dataset": DATASET_VERSION,
        "variable": ANNUAL_COLUMN_NAME,
        "variable_description": (
            "Anomalia de temperatura superficial global, promedio de los 12 "
            "meses del anio calendario (columna J-D de la tabla anual "
            "oficial de GISTEMP)."
        ),
        "baseline_period": BASELINE_PERIOD,
        "integration_mode": "annual-global-overlay",
        "integration_mode_note": (
            "Cada entrada empareja un mapa ANUAL estatico del EIC/SVS con el "
            "indicador GLOBAL ANUAL del mismo anio y mismo baseline. No se "
            "promedia la rejilla con o sin pesos de area en este script: se "
            "usa el valor J-D ya publicado por NASA GISS. No sustituye el "
            "dato local de public/data/gistemp/*.json."
        ),
        "revision_warning": (
            "GISTEMP revisa sus resultados cuando llegan datos de estaciones "
            "nuevos o corregidos. El valor numerico aqui proviene del CSV "
            "vigente en csv_source.download_date_utc; el frame de imagen fue "
            "publicado en frame.frame_last_modified_utc. Si esas fechas no "
            "coinciden, el valor numerico actual puede diferir levemente del "
            "que se uso para generar el mapa."
        ),
        "excluded_years": EXCLUDED_YEARS_NOTE,
        "csv_source": {
            "dataset_page": SOURCE_DATASET_PAGE,
            "file_url": csv_url,
            "download_date_utc": csv_download_date,
            "original_file_sha256": csv_checksum,
        },
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "entries": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        help="Ruta a un CSV local ya descargado (si se omite, se descarga desde NASA GISS)",
        default=None,
    )
    parser.add_argument(
        "--years",
        type=int,
        nargs="+",
        default=sorted(VERIFIED_ANNUAL_FRAMES.keys()),
        help="Anios a incluir (solo se exportan los que tengan frame verificado y valor CSV)",
    )
    args = parser.parse_args()

    csv_path, download_date = resolve_csv(args.input)
    checksum = sha256_of_file(csv_path)
    annual_values = parse_annual_values(csv_path)
    payload = build_eic_annual(
        args.years, annual_values, SOURCE_CSV_URL, checksum, download_date
    )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Escrito {OUT_PATH} ({len(payload['entries'])} anio(s))", file=sys.stderr)


if __name__ == "__main__":
    main()
