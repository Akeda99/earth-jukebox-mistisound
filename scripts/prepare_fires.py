#!/usr/bin/env python3
"""Exporta una rejilla mensual de detecciones de incendios MODIS (NASA FIRMS)
a JSON compacto de 2 grados para Earth Jukebox, limitado a la region
Peru + Amazonia.

Fuente de datos: NASA FIRMS (Fire Information for Resource Management
System), detecciones de archivo MODIS Collection 6.1.
  - Pagina de descarga: https://firms.modaps.eosdis.nasa.gov/download/
  - API de area (CSV):  https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SENSOR}/{bbox}/{day_range}/{date}

ACCESO REAL VERIFICADO (ver docs/dj-data-sources.md): tanto la herramienta
web "Download" como la API /api/area/ exigen un MAP_KEY gratuito, obtenido
mediante registro en https://firms.modaps.eosdis.nasa.gov/api/map_key/ . Sin
MAP_KEY, la API responde "Invalid API call." (HTTP 400, verificado). Este
script NO intenta adivinar ni sortear esa clave. Si el usuario ya tiene un
MAP_KEY propio, puede exponerlo en la variable de entorno FIRMS_MAP_KEY y el
script hara las llamadas oficiales documentadas (maximo 10 dias por llamada)
para cubrir el mes solicitado. Si no hay MAP_KEY disponible, el script
reporta el bloqueo exacto y se detiene sin generar ningun archivo de salida.

Alternativamente acepta un CSV de archivo FIRMS ya descargado manualmente
por el usuario via --input (debe incluir la columna 'type', presente en el
CSV de archivo pero no en la API NRT).

Reglas de conversion aplicadas (documentadas tambien en
docs/dj-data-sources.md):
  - Region declarada: bounding box Peru + Amazonia
    [-82, -20, -45, 5] (lon_oeste, lat_sur, lon_este, lat_norte).
  - Se conservan solo detecciones con confidence >= 30 (MODIS C6.1 usa una
    escala de confianza 0-100%; FIRMS recomienda excluir las de confianza
    baja para analisis cuantitativos).
  - Se conservan solo detecciones con type == 0 ("presumed vegetation
    fire"), excluyendo volcanes activos (type 1), otras fuentes estaticas de
    calor (type 2) y deteccion en alta mar/offshore (type 3): esto evita
    atribuir como "incendio" algo que el propio producto no clasifica como
    fuego de vegetacion.
  - El valor de cada celda es el CONTEO de detecciones filtradas del mes
    (no area quemada ni "incendios unicos": una misma quema puede generar
    varias detecciones en distintos pasos del satelite).
  - Celdas dentro del bounding box declarado: conteo (puede ser 0).
    Celdas fuera del bounding box: null (sin cobertura declarada).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dj_index_common import update_index_section  # noqa: E402

DOWNLOAD_PAGE = "https://firms.modaps.eosdis.nasa.gov/download/"
MAP_KEY_REGISTRATION_PAGE = "https://firms.modaps.eosdis.nasa.gov/api/map_key/"
API_AREA_TEMPLATE = (
    "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{map_key}/{sensor}/{bbox}/{day_range}/{date}"
)
SENSOR = "MODIS_SP"  # archivo (standard processing), no near-real-time
DATASET_VERSION = "NASA FIRMS - MODIS Collection 6.1 (archive, MODIS_SP)"
BBOX = (-82.0, -20.0, -45.0, 5.0)  # lon_west, lat_south, lon_east, lat_north
CONFIDENCE_MIN = 30
VEGETATION_FIRE_TYPE = "0"
GRID_RESOLUTION_DEG = 2
API_MAX_DAYS_PER_CALL = 10

ROOT = Path(__file__).resolve().parent.parent
WORK_RAW_DIR = ROOT / "work" / "raw-dj" / "fires"
OUT_DIR = ROOT / "public" / "data" / "fires"
INDEX_PATH = ROOT / "public" / "data" / "dj-index.json"

REQUIRED_COLUMNS = {
    "latitude", "longitude", "acq_date", "confidence", "type",
}


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def month_day_range(year: int, month: int) -> tuple[date, date]:
    start = date(year, month, 1)
    if month == 12:
        end = date(year, 12, 31)
    else:
        end = date(year, month + 1, 1) - timedelta(days=1)
    return start, end


def report_blocked_download(detail: str) -> None:
    bbox_str = ",".join(str(v) for v in BBOX)
    print(
        "BLOQUEADO: no se pudo descargar detecciones FIRMS sin credenciales.\n"
        f"  Detalle: {detail}\n"
        "  La API de FIRMS (/api/area/) y la herramienta de descarga web "
        "exigen un MAP_KEY gratuito (verificado: sin clave valida la API "
        "responde HTTP 400 'Invalid API call.').\n"
        f"  Registro oficial: {MAP_KEY_REGISTRATION_PAGE}\n"
        "  Si ya tiene un MAP_KEY propio, expongalo como variable de entorno "
        "FIRMS_MAP_KEY y vuelva a ejecutar el script.\n"
        f"  Alternativamente, use la herramienta web ({DOWNLOAD_PAGE}) para "
        f"descargar un CSV de archivo (bbox {bbox_str}) y pase su ruta con --input.\n"
        "  No se genero ningun archivo de salida.",
        file=sys.stderr,
    )


def download_via_api(year: int, month: int, map_key: str, dest: Path) -> bool:
    start, end = month_day_range(year, month)
    bbox_str = ",".join(str(v) for v in BBOX)
    rows: list[str] = []
    header: str | None = None

    cursor = start
    while cursor <= end:
        remaining = (end - cursor).days + 1
        day_range = min(API_MAX_DAYS_PER_CALL, remaining)
        url = API_AREA_TEMPLATE.format(
            map_key=map_key,
            sensor=SENSOR,
            bbox=bbox_str,
            day_range=day_range,
            date=cursor.isoformat(),
        )
        req = urllib.request.Request(url, headers={"User-Agent": "earth-jukebox-prepare-script/1"})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                text = resp.read().decode("utf-8")
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            report_blocked_download(f"{type(exc).__name__}: {exc} (url={url})")
            return False

        lines = text.strip().splitlines()
        if not lines or lines[0].startswith("Invalid") or "error" in lines[0].lower():
            report_blocked_download(f"Respuesta inesperada de la API: {lines[:1]} (url={url})")
            return False

        if header is None:
            header = lines[0]
            rows.append(header)
        rows.extend(lines[1:])

        cursor = cursor + timedelta(days=day_range)

    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(rows) + "\n")
    return True


def resolve_input_file(input_arg: str | None, year: int, month: int) -> tuple[Path, str]:
    if input_arg:
        original = Path(input_arg).resolve()
        if not original.exists():
            raise FileNotFoundError(f"Archivo de entrada no encontrado: {original}")
        download_date = datetime.fromtimestamp(
            original.stat().st_mtime, tz=timezone.utc
        ).isoformat()
        return original, download_date

    cached = WORK_RAW_DIR / f"firms_{SENSOR}_{year:04d}{month:02d}.csv"
    if cached.exists():
        download_date = datetime.fromtimestamp(cached.stat().st_mtime, tz=timezone.utc).isoformat()
        return cached, download_date

    map_key = os.environ.get("FIRMS_MAP_KEY")
    if not map_key:
        report_blocked_download("No se encontro la variable de entorno FIRMS_MAP_KEY")
        raise SystemExit(1)

    ok = download_via_api(year, month, map_key, cached)
    if not ok:
        raise SystemExit(1)
    return cached, datetime.now(timezone.utc).isoformat()


def build_grid_axes() -> tuple[np.ndarray, np.ndarray]:
    n_lat = round(180 / GRID_RESOLUTION_DEG)
    n_lon = round(360 / GRID_RESOLUTION_DEG)
    lat_centers = -90 + GRID_RESOLUTION_DEG * (np.arange(n_lat) + 0.5)
    lon_centers = -180 + GRID_RESOLUTION_DEG * (np.arange(n_lon) + 0.5)
    return lat_centers, lon_centers


def cell_index(lat: float, lon: float, lat_centers: np.ndarray, lon_centers: np.ndarray) -> tuple[int, int]:
    lat_i = int(np.argmin(np.abs(lat_centers - lat)))
    lon_i = int(np.argmin(np.abs(lon_centers - lon)))
    return lat_i, lon_i


def in_bbox(lat: float, lon: float) -> bool:
    lon_w, lat_s, lon_e, lat_n = BBOX
    return lon_w <= lon <= lon_e and lat_s <= lat <= lat_n


def count_detections(csv_path: Path, year: int, month: int) -> tuple[np.ndarray, int, int]:
    """Devuelve (counts[lat,lon] con -1 = fuera de bbox, total_rows_leidas,
    total_filas_retenidas_tras_filtros)."""
    lat_centers, lon_centers = build_grid_axes()
    n_lat, n_lon = len(lat_centers), len(lon_centers)
    counts = np.full((n_lat, n_lon), -1, dtype=np.int64)

    # Marca como "con cobertura" (0) toda celda cuyo centro cae dentro del bbox.
    for lat_i, lat_c in enumerate(lat_centers):
        for lon_i, lon_c in enumerate(lon_centers):
            if in_bbox(lat_c, lon_c):
                counts[lat_i, lon_i] = 0

    period_prefix = f"{year:04d}-{month:02d}"
    total_rows = 0
    kept_rows = 0

    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or not REQUIRED_COLUMNS.issubset(set(reader.fieldnames)):
            missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
            raise ValueError(
                f"El CSV no tiene las columnas esperadas de un archivo FIRMS de archivo "
                f"(faltan: {sorted(missing)}). Use un CSV de la herramienta de descarga de "
                "archivo (Archive Download Tool), no de la API NRT, que incluye 'type'."
            )

        for row in reader:
            total_rows += 1
            if not row["acq_date"].startswith(period_prefix):
                continue
            try:
                conf = float(row["confidence"])
            except ValueError:
                continue
            if conf < CONFIDENCE_MIN:
                continue
            if row["type"].strip() != VEGETATION_FIRE_TYPE:
                continue
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            if not in_bbox(lat, lon):
                continue
            lat_i, lon_i = cell_index(lat, lon, lat_centers, lon_centers)
            counts[lat_i, lon_i] += 1
            kept_rows += 1

    return counts, total_rows, kept_rows


def export_month(csv_path: Path, year: int, month: int, download_date: str) -> Path:
    lat_centers, lon_centers = build_grid_axes()
    counts, total_rows, kept_rows = count_detections(csv_path, year, month)

    values = []
    for row in counts:
        for v in row:
            values.append(None if v < 0 else int(v))

    null_count = sum(1 for v in values if v is None)
    checksum = sha256_of_file(csv_path)
    bbox_str = ",".join(str(v) for v in BBOX)

    payload = {
        "dataset": DATASET_VERSION,
        "variable": "fire_detection_count",
        "period": f"{year}-{month:02d}",
        "units": "detections/month/cell (conteo, no area quemada)",
        "grid_resolution_deg": GRID_RESOLUTION_DEG,
        "grid_shape": {"lat": len(lat_centers), "lon": len(lon_centers)},
        "value_order": "row-major: fila=lat (ascendente), columna=lon (ascendente); indice = lat_idx * n_lon + lon_idx",
        "axes": {
            "lat_centers": [round(float(v), 4) for v in lat_centers],
            "lon_centers": [round(float(v), 4) for v in lon_centers],
        },
        "region": {
            "name": "Peru + Amazonia (bounding box declarado)",
            "bbox_lon_west_lat_south_lon_east_lat_north": list(BBOX),
            "note": "null fuera del bbox; dentro del bbox, 0 significa cobertura confirmada sin detecciones filtradas",
        },
        "filters": {
            "sensor": SENSOR,
            "confidence_min_percent": CONFIDENCE_MIN,
            "type_kept": "0 (presumed vegetation fire)",
            "rows_read": total_rows,
            "rows_kept_after_filters": kept_rows,
        },
        "null_count": null_count,
        "cell_count": len(values),
        "values": values,
        "source": {
            "download_page": DOWNLOAD_PAGE,
            "api_template": API_AREA_TEMPLATE,
            "sensor": SENSOR,
            "bbox": bbox_str,
            "download_date_utc": download_date,
            "original_file_sha256": checksum,
        },
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{year}-{month:02d}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(
        f"Exportado {out_path} ({kept_rows}/{total_rows} detecciones retenidas, "
        f"{null_count} celdas fuera de bbox)",
        file=sys.stderr,
    )
    return out_path


def rebuild_dj_index() -> None:
    files = []
    if OUT_DIR.exists():
        for path in sorted(OUT_DIR.glob("*.json")):
            rel = path.relative_to(INDEX_PATH.parent).as_posix()
            files.append({"path": rel, "size_bytes": path.stat().st_size})
    update_index_section(INDEX_PATH, "fires", files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Ruta a un CSV de archivo FIRMS local", default=None)
    parser.add_argument("--year", type=int, default=2023)
    parser.add_argument("--month", type=int, default=1)
    args = parser.parse_args()

    csv_path, download_date = resolve_input_file(args.input, args.year, args.month)
    export_month(csv_path, args.year, args.month, download_date)
    rebuild_dj_index()


if __name__ == "__main__":
    main()
