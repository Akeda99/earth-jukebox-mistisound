#!/usr/bin/env python3
"""Exporta una rejilla mensual de concentracion de hielo marino del
producto "Sea Ice Index" G02135 v4.0 a JSON compacto de 2 grados.

Fuente de datos: NOAA/NSIDC G02135 "Sea Ice Index", version 4.0. Este es
un producto **NOAA** distribuido via NSIDC; el algoritmo de concentracion
subyacente es NASA Team en AMBOS casos: NSIDC-0051 hasta diciembre 2024,
NSIDC-0803 desde enero 2025 (guia de usuario G02135 v4, secciones
2.1/2.3/6.4.1). Fue desarrollado en NASA GSFC, pero el
dataset en si NO es un producto NASA primario (ver docs/pending-data-research.md
seccion 2). Siempre se etiqueta como "NOAA/NSIDC G02135", nunca como
"NASA dataset".
  - Pagina del dataset: https://nsidc.org/data/g02135/versions/4
  - Guia de usuario (seccion 3.6.1, tabla 5):
    https://nsidc.org/sites/default/files/documents/user-guide/g02135-v004-userguide.pdf
  - Archivo GeoTIFF mensual (anonimo, HTTP, sin login):
    https://noaadata.apps.nsidc.org/NOAA/G02135/{hemisferio}/monthly/geotiff/{MM}_{Mon}/{N|S}_{YYYYMM}_concentration_v4.0.tif

ACCESO: a diferencia de NSIDC-0051 (login OAuth obligatorio), este host
(`noaadata.apps.nsidc.org`, nota el prefijo "noaadata" en vez de
"daacdata") sirve los GeoTIFF de forma anonima, verificado con
descargas reales (ver docs/pending-data-research.md). No se usa ningun
token ni credencial.

Formato del archivo (GeoTIFF paleta-color de banda unica, uint16):
  - Valor crudo 0..1000: fraccion = valor/1000 (0.0..1.0). El umbral de
    deteccion del producto es 15%: valores por debajo de ese umbral ya
    vienen fijados a 0 por NSIDC en el archivo fuente, lo cual NO
    equivale a "sin hielo confirmado ausente", solo a "por debajo del
    umbral de deteccion del sensor" (seccion 3.6.1 de la guia de
    usuario). La UI debe explicar esto, no afirmar ausencia absoluta.
  - Flags especiales de la tabla 5 (guia de usuario), NUNCA promediados
    como si fueran hielo real ni como 0%:
      2510 = pole hole (sin cobertura del sensor cerca del polo)
      2530 = costa
      2540 = tierra
      2550 = sin dato / missing
  - Periodo de fuente mensual: NSIDC-0051 hasta diciembre 2024, NSIDC-0803
    desde enero 2025 (guia de usuario G02135 v4, secciones 2.1/2.3/6.4.1).
    AMBAS fuentes usan el algoritmo NASA Team (NASA GSFC): la transicion
    es de NOMBRE DE DATASET, no de algoritmo. "Bootstrap" es el algoritmo
    de OTRO producto (NSIDC-0079, usado por la pagina "current state of
    sea ice cover" de NASA GSFC cryo), no de G02135: no deben confundirse.
    Este script no distingue version de dataset por fecha porque el
    GeoTIFF ya trae el valor final; el campo "algorithm_period_note" en
    la salida documenta esta limitacion.

CRS y geotransformacion REALES (no asumidos por hemisferio): cada
GeoTIFF declara su propio EPSG en el tag GeoKeyDirectoryTag (clave
3072, ProjectedCSTypeGeoKey) y su propia resolucion/origen en
ModelPixelScaleTag (33550) + ModelTiepointTag (33922). Este script lee
esos tres tags de CADA archivo descargado y construye la rejilla de
centros de pixel a partir de ellos — nunca asume "EPSG:3411 para
norte" como constante fija aunque en la practica coincida.

Agregacion a la rejilla de 2 grados: promedio aritmetico de los
pixeles fuente (25x25 km, area fisica constante) cuyo centro
reproyectado a lon/lat cae dentro de cada celda destino, usando solo
pixeles de oceano con valor valido (0..1000). Esto es una
APROXIMACION: se promedian muestras puntuales (centros de pixel
proyectados) dentro de la celda destino, no un promedio geodesico
ponderado por area real en superficie esferica (que variaria segun
latitud). La cobertura (cuantos pixeles validos aportaron a cada
celda) se registra en "coverage" para que el consumidor pueda juzgar
la confiabilidad de cada celda. Tierra/costa/pole-hole/sin-dato se
excluyen siempre del numerador y denominador (nunca se cuentan como
0% de hielo).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import tifffile
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dj_index_common import update_index_section  # noqa: E402

DATASET_PAGE = "https://nsidc.org/data/g02135/versions/4"
USER_GUIDE = "https://nsidc.org/sites/default/files/documents/user-guide/g02135-v004-userguide.pdf"
HTTPS_HOST = "noaadata.apps.nsidc.org"
DATASET_VERSION = (
    "NOAA/NSIDC G02135 Sea Ice Index v4.0 (derivado de algoritmos NASA GSFC; "
    "producto NOAA, no un dataset NASA primario)"
)
ALGORITHM_PERIOD_NOTE = (
    "Fuente mensual: NSIDC-0051 hasta diciembre 2024, NSIDC-0803 desde "
    "enero 2025 (guia de usuario G02135 v4, secciones 2.1/2.3/6.4.1). "
    "AMBAS usan el algoritmo NASA Team (NASA GSFC); la transicion es de "
    "nombre de dataset, no de algoritmo. 'Bootstrap' es el algoritmo de "
    "NSIDC-0079, un producto DISTINTO: no se usa aqui. Este script no "
    "reconstruye esa procedencia por mes, solo exporta el valor final ya "
    "presente en el GeoTIFF de NSIDC/NOAA."
)
DETECTION_THRESHOLD_NOTE = (
    "G02135 aplica un umbral de deteccion del 15% a nivel de PIXEL FUENTE: "
    "un valor crudo de 0 en el GeoTIFF original significa 'bajo el umbral "
    "de deteccion del sensor', no 'ausencia absoluta de hielo confirmada'. "
    "Una celda AGREGADA de 2 grados con valor < 0.15 NO implica lo mismo: "
    "puede resultar de promediar pixeles con hielo real (>=0.15) junto con "
    "pixeles de agua abierta (0.0), por lo que un agregado bajo no equivale "
    "a 'todos los pixeles fuente bajo el umbral'. Solo un valor fuente "
    "exactamente 0 tiene esa interpretacion; el agregado es una mezcla."
)

MONTH_FOLDERS = {
    1: "01_Jan", 2: "02_Feb", 3: "03_Mar", 4: "04_Apr", 5: "05_May", 6: "06_Jun",
    7: "07_Jul", 8: "08_Aug", 9: "09_Sep", 10: "10_Oct", 11: "11_Nov", 12: "12_Dec",
}

# Tabla 5 de la guia de usuario (ver docstring arriba).
FLAG_POLE_HOLE = 2510
FLAG_COAST = 2530
FLAG_LAND = 2540
FLAG_MISSING = 2550
MAX_VALID_RAW = 1000
RAW_TO_FRACTION = 1.0 / 1000.0

FLAGS_EXCLUDED = {
    "pole_hole": FLAG_POLE_HOLE,
    "coast": FLAG_COAST,
    "land": FLAG_LAND,
    "missing": FLAG_MISSING,
    "note": "pole-hole/costa/tierra/sin-dato se excluyen del promedio; nunca se cuentan como 0% de hielo",
}

GEOKEY_PROJECTED_CS_TYPE = 3072
TAG_MODEL_PIXEL_SCALE = 33550
TAG_MODEL_TIEPOINT = 33922
TAG_GEO_KEY_DIRECTORY = 34735

GRID_RESOLUTION_DEG = 2
SOURCE_CELL_SIZE_KM = 25
DOWNLOAD_TIMEOUT_S = 30
DOWNLOAD_RETRIES = 3
DOWNLOAD_RETRY_BACKOFF_S = 2

ROOT = Path(__file__).resolve().parent.parent
WORK_RAW_DIR = ROOT / "work" / "raw-dj" / "sea-ice-g02135"
OUT_DIR = ROOT / "public" / "data" / "sea-ice-g02135"
INDEX_PATH = ROOT / "public" / "data" / "dj-index.json"


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def source_file_url(hemisphere: str, year: int, month: int) -> str:
    hem_dir = "north" if hemisphere == "north" else "south"
    hem_code = "N" if hemisphere == "north" else "S"
    month_folder = MONTH_FOLDERS[month]
    return (
        f"https://{HTTPS_HOST}/NOAA/G02135/{hem_dir}/monthly/geotiff/{month_folder}/"
        f"{hem_code}_{year:04d}{month:02d}_concentration_v4.0.tif"
    )


def download_with_retry(url: str, dest: Path) -> bool:
    """Descarga anonima con timeout y reintentos acotados (nunca indefinidos).
    Devuelve False (sin lanzar) si todos los intentos fallan, para que el
    llamador decida saltarse el mes/hemisferio en vez de abortar todo el
    proceso o rellenar con datos inventados."""
    last_error: Exception | None = None
    for attempt in range(1, DOWNLOAD_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "earth-jukebox-prepare-script/1"})
            with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as resp:
                data = resp.read()
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as out:
                out.write(data)
            return True
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if attempt < DOWNLOAD_RETRIES:
                time.sleep(DOWNLOAD_RETRY_BACKOFF_S * attempt)
    print(f"BLOQUEADO/FALLO descarga tras {DOWNLOAD_RETRIES} intentos: {url} ({last_error})", file=sys.stderr)
    return False


def resolve_hemisphere_file(
    input_arg: str | None, hemisphere: str, year: int, month: int
) -> tuple[Path, str] | None:
    if input_arg:
        original = Path(input_arg).resolve()
        if not original.exists():
            raise FileNotFoundError(f"Archivo de entrada no encontrado: {original}")
        download_date = datetime.fromtimestamp(original.stat().st_mtime, tz=timezone.utc).isoformat()
        return original, download_date

    cached = WORK_RAW_DIR / f"{hemisphere}_{year:04d}{month:02d}.tif"
    if cached.exists():
        download_date = datetime.fromtimestamp(cached.stat().st_mtime, tz=timezone.utc).isoformat()
        return cached, download_date

    url = source_file_url(hemisphere, year, month)
    ok = download_with_retry(url, cached)
    if not ok:
        return None
    return cached, datetime.now(timezone.utc).isoformat()


def _decode_epsg_from_geokeys(geokeys: tuple[int, ...]) -> int:
    """Lee el EPSG real desde GeoKeyDirectoryTag (clave 3072,
    ProjectedCSTypeGeoKey), en vez de asumir un EPSG fijo por hemisferio.
    Formato: encabezado de 4 enteros, luego N entradas de 4 enteros
    (KeyID, TIFFTagLocation, Count, Value)."""
    num_keys = geokeys[3]
    for i in range(num_keys):
        base = 4 + i * 4
        key_id, tag_location, count, value = geokeys[base : base + 4]
        if key_id == GEOKEY_PROJECTED_CS_TYPE and tag_location == 0 and count == 1:
            return value
    raise ValueError("No se encontro ProjectedCSTypeGeoKey (3072) real en el GeoTIFF")


def read_geotiff_grid(tif_path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Lee un GeoTIFF G02135 y devuelve (lon_2d, lat_2d, fraction_2d, epsg)
    usando EXCLUSIVAMENTE los tags reales del archivo (GeoKeyDirectoryTag,
    ModelPixelScaleTag, ModelTiepointTag), sin asumir resolucion/origen/CRS
    fijos de antemano."""
    with tifffile.TiffFile(str(tif_path)) as tif:
        page = tif.pages[0]
        raw = page.asarray().astype(np.float64)  # (rows, cols)

        scale_x, scale_y, _ = page.tags[TAG_MODEL_PIXEL_SCALE].value
        tiepoint = page.tags[TAG_MODEL_TIEPOINT].value
        # (I, J, K, X, Y, Z): raster point (I,J) -> modelo (X,Y). Con
        # RasterPixelIsArea (comun en este producto), (0,0) es la esquina
        # superior izquierda del area de pixel, no su centro.
        origin_x, origin_y = tiepoint[3], tiepoint[4]

        geokeys = page.tags[TAG_GEO_KEY_DIRECTORY].value
        epsg = _decode_epsg_from_geokeys(geokeys)

    n_rows, n_cols = raw.shape
    col_idx = np.arange(n_cols)
    row_idx = np.arange(n_rows)
    x_centers = origin_x + (col_idx + 0.5) * scale_x
    y_centers = origin_y - (row_idx + 0.5) * scale_y
    xx, yy = np.meshgrid(x_centers, y_centers)

    transformer = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    lon_2d, lat_2d = transformer.transform(xx, yy)

    fraction = np.full(raw.shape, np.nan)
    valid = raw <= MAX_VALID_RAW
    fraction[valid] = raw[valid] * RAW_TO_FRACTION
    # 2510/2530/2540/2550 (y cualquier otro valor fuera de 0..1000) quedan
    # NaN: nunca se tratan como 0% de hielo.

    return lon_2d, lat_2d, fraction, epsg


def build_grid_axes() -> tuple[np.ndarray, np.ndarray]:
    n_lat = round(180 / GRID_RESOLUTION_DEG)
    n_lon = round(360 / GRID_RESOLUTION_DEG)
    lat_centers = -90 + GRID_RESOLUTION_DEG * (np.arange(n_lat) + 0.5)
    lon_centers = -180 + GRID_RESOLUTION_DEG * (np.arange(n_lon) + 0.5)
    return lat_centers, lon_centers


def accumulate_hemisphere(
    lon_2d: np.ndarray,
    lat_2d: np.ndarray,
    fraction_2d: np.ndarray,
    sum_grid: np.ndarray,
    weight_grid: np.ndarray,
    lat_centers: np.ndarray,
    lon_centers: np.ndarray,
) -> None:
    """Acumula promedio ARITMETICO (no geodesico) de muestras puntuales
    (centros de pixel proyectados) validas por celda destino de 2 grados.
    Todos los pixeles fuente tienen igual area fisica (25x25 km), pero el
    promedio resultante es sobre conteo de muestras, no sobre area real en
    la esfera (ver nota de aproximacion en el docstring del modulo)."""
    valid = ~np.isnan(fraction_2d)
    lat_idx = np.clip(((lat_2d[valid] - (-90)) / GRID_RESOLUTION_DEG).astype(np.int64), 0, len(lat_centers) - 1)
    lon_idx = np.clip(((lon_2d[valid] - (-180)) / GRID_RESOLUTION_DEG).astype(np.int64), 0, len(lon_centers) - 1)
    vals = fraction_2d[valid]

    np.add.at(sum_grid, (lat_idx, lon_idx), vals)
    np.add.at(weight_grid, (lat_idx, lon_idx), 1.0)


def export_month(
    north_file: tuple[Path, str] | None,
    south_file: tuple[Path, str] | None,
    year: int,
    month: int,
) -> Path:
    if north_file is None and south_file is None:
        raise SystemExit(1)

    lat_centers, lon_centers = build_grid_axes()
    sum_grid = np.zeros((len(lat_centers), len(lon_centers)))
    weight_grid = np.zeros((len(lat_centers), len(lon_centers)))

    sources_meta = {}
    for hemisphere, file_info in (("north", north_file), ("south", south_file)):
        if file_info is None:
            continue
        path, download_date = file_info
        lon_2d, lat_2d, fraction_2d, epsg = read_geotiff_grid(path)
        accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)
        sources_meta[hemisphere] = {
            "file_url": source_file_url(hemisphere, year, month),
            "download_date_utc": download_date,
            "original_file_sha256": sha256_of_file(path),
            "epsg_decoded_from_geotiff": epsg,
            "source_grid_shape": list(fraction_2d.shape),
        }

    out_grid = np.where(weight_grid > 0, np.divide(sum_grid, weight_grid, where=weight_grid > 0), np.nan)

    values = []
    coverage = []
    for lat_i in range(out_grid.shape[0]):
        for lon_i in range(out_grid.shape[1]):
            v = out_grid[lat_i, lon_i]
            w = weight_grid[lat_i, lon_i]
            values.append(None if np.isnan(v) else round(float(v), 4))
            coverage.append(int(w))

    null_count = sum(1 for v in values if v is None)

    # Hash de version del paquete de datos (para sharing/preset.js
    # dataVersions.seaIce): combina los sha256 de los originales reales de
    # cada hemisferio en un unico valor comparable por periodo, igual
    # espiritu que dataset.source.original_file_sha256 de GISTEMP.
    version_hash = hashlib.sha256(
        ";".join(f"{hem}:{meta['original_file_sha256']}" for hem, meta in sorted(sources_meta.items())).encode(
            "utf-8"
        )
    ).hexdigest()

    payload = {
        "dataset": DATASET_VERSION,
        "version_hash": version_hash,
        "variable": "sea_ice_concentration",
        "period": f"{year}-{month:02d}",
        "units": "fraction (0.0-1.0) of valid ocean area covered by sea ice",
        "grid_resolution_deg": GRID_RESOLUTION_DEG,
        "source_grid": {
            "cell_size_km": SOURCE_CELL_SIZE_KM,
            "projection": "polar stereographic, EPSG decodificado por archivo (ver source.hemispheres[*].epsg_decoded_from_geotiff)",
        },
        "grid_shape": {"lat": len(lat_centers), "lon": len(lon_centers)},
        "value_order": "row-major: fila=lat (ascendente), columna=lon (ascendente); indice = lat_idx * n_lon + lon_idx",
        "axes": {
            "lat_centers": [round(float(v), 4) for v in lat_centers],
            "lon_centers": [round(float(v), 4) for v in lon_centers],
        },
        "flags_excluded_from_average": FLAGS_EXCLUDED,
        "detection_threshold_note": DETECTION_THRESHOLD_NOTE,
        "algorithm_period_note": ALGORITHM_PERIOD_NOTE,
        "aggregation_approximation_note": (
            "Promedio aritmetico de muestras puntuales (centros de pixel de "
            "25km reproyectados) dentro de cada celda de 2 grados, NO un "
            "promedio geodesico ponderado por area esferica real. 'coverage' "
            "indica cuantos pixeles validos aportaron a cada celda (mismo "
            "orden que 'values')."
        ),
        "hemispheres_included": list(sources_meta.keys()),
        "null_count": null_count,
        "cell_count": len(values),
        "values": values,
        "coverage": coverage,
        "source": {
            "dataset_page": DATASET_PAGE,
            "user_guide": USER_GUIDE,
            "hemispheres": sources_meta,
        },
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{year}-{month:02d}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(
        f"Exportado {out_path} ({len(values)} celdas, {null_count} sin cobertura oceanica valida)",
        file=sys.stderr,
    )
    return out_path


def rebuild_dj_index() -> None:
    files = []
    if OUT_DIR.exists():
        for path in sorted(OUT_DIR.glob("*.json")):
            rel = path.relative_to(INDEX_PATH.parent).as_posix()
            files.append({"path": rel, "size_bytes": path.stat().st_size})
    update_index_section(INDEX_PATH, "sea_ice_g02135", files)


def run_single_month(args: argparse.Namespace) -> bool:
    north_file = resolve_hemisphere_file(args.input_north, "north", args.year, args.month)
    south_file = resolve_hemisphere_file(args.input_south, "south", args.year, args.month)
    if north_file is None and south_file is None:
        print(f"{args.year}-{args.month:02d}: ningun hemisferio disponible, se omite (sin salida).", file=sys.stderr)
        return False
    export_month(north_file, south_file, args.year, args.month)
    return True


def run_all_2023() -> None:
    """Intenta exportar los 12 meses de 2023, norte+sur emparejados. Un mes
    se omite por completo (nunca se rellena con 0) si falta cualquiera de
    los dos hemisferios reales."""
    exported = 0
    for month in range(1, 13):
        north_file = resolve_hemisphere_file(None, "north", 2023, month)
        south_file = resolve_hemisphere_file(None, "south", 2023, month)
        if north_file is None or south_file is None:
            print(f"2023-{month:02d}: par norte/sur incompleto, se omite (sin salida, sin ceros).", file=sys.stderr)
            continue
        export_month(north_file, south_file, 2023, month)
        exported += 1
    print(f"Meses 2023 exportados: {exported}/12", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input-north", help="Ruta a un GeoTIFF G02135 hemisferio norte local", default=None)
    parser.add_argument("--input-south", help="Ruta a un GeoTIFF G02135 hemisferio sur local", default=None)
    parser.add_argument("--year", type=int, default=2023)
    parser.add_argument("--month", type=int, default=1)
    parser.add_argument("--all-2023", action="store_true", help="Exporta los 12 meses de 2023 (norte+sur emparejados, descarga real)")
    args = parser.parse_args()

    if args.all_2023:
        run_all_2023()
        rebuild_dj_index()
        return

    if not run_single_month(args):
        raise SystemExit(1)
    rebuild_dj_index()


if __name__ == "__main__":
    main()
