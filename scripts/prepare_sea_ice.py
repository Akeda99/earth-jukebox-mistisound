#!/usr/bin/env python3
"""Exporta una rejilla mensual de concentracion de hielo marino (NSIDC-0051,
algoritmo NASA Team) a JSON compacto de 2 grados para Earth Jukebox.

Fuente de datos: "Sea Ice Concentrations from Nimbus-7 SMMR and DMSP
SSM/I-SSMIS Passive Microwave Data, Version 2" (NSIDC-0051), NASA Team,
NSIDC/NASA GSFC.
  - Pagina del dataset: https://nsidc.org/data/nsidc-0051/versions/2
  - Guia de usuario:    https://nsidc.org/sites/default/files/documents/user-guide/nsidc-0051-v002-userguide.pdf
  - Archivo HTTPS (ej): https://daacdata.apps.nsidc.org/pub/DATASETS/NSIDC-0051/NSIDC-0051.002/{YYYY}.{MM}.01/NSIDC0051_SEAICE_PS_{HEM}25km_{YYYY}{MM}_v2.0.nc

ACCESO REAL VERIFICADO (ver docs/dj-data-sources.md): la descarga HTTPS
directa (daacdata.apps.nsidc.org) redirige a
https://urs.earthdata.nasa.gov/oauth/authorize (verificado con curl -L,
HTTP 200 final mostrando la pagina de login OAuth). Se requiere una cuenta
gratuita de NASA Earthdata Login. Este script NO intenta sortear ese login.
Solo descarga automaticamente si el usuario ya tiene configuradas sus
propias credenciales en ~/.netrc (mecanismo oficial documentado por NASA).
Si no hay credenciales disponibles, el script reporta el bloqueo exacto y
se detiene sin generar ningun archivo de salida.

Alternativamente acepta archivos NetCDF ya descargados manualmente por el
usuario via --input-north / --input-south (uno o ambos hemisferios; el que
falte queda como cobertura nula en su hemisferio).

Reglas de conversion (ver tambien docs/dj-data-sources.md):
  - Variable NSIDC: <SENSOR>_ICECON, dims (t, y, x). Para 2023 el sensor es
    DMSP-F17/SSMIS => variable 'F17_ICECON' (periodo oficial: 2008-01-01 a
    2025-12-31 segun la guia de usuario).
  - Valores 0..250 = concentracion de hielo 0..100% (factor 100/250=0.4).
    Flags especiales (NO se tratan como 0%): 251=pole hole (excluido del
    promedio, no se inventa un valor), 252=no usado, 253=costa, 254=tierra
    (excluida explicitamente, nunca se cuenta como 0% de hielo), 255 (u
    otro valor fuera de 0..254) = sin dato/_FillValue.
  - Reproyeccion: cada centro de celda (x,y en metros, proyeccion polar
    estereografica real del archivo) se transforma a lon/lat con pyproj
    usando el EPSG oficial de cada hemisferio (3411 norte, 3412 sur).
  - Agregacion a la rejilla de 2 grados: promedio ponderado por area de las
    celdas fuente de 25x25 km (todas del mismo tamano fisico) que caen
    dentro de cada celda destino, usando solo pixeles de oceano con dato
    valido (se excluyen tierra, costa, pole hole y sin-dato del numerador Y
    del denominador). Celdas destino sin ningun pixel oceanico valido
    quedan en null (no se asume 0% ni se marca tierra como oceano sin
    hielo).
  - Unidad de salida: fraccion 0..1 (concentracion de hielo sobre area
    oceanica valida), explicitada en el campo "units".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import netrc
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import netCDF4 as nc
import numpy as np
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dj_index_common import update_index_section  # noqa: E402

DATASET_PAGE = "https://nsidc.org/data/nsidc-0051/versions/2"
USER_GUIDE = "https://nsidc.org/sites/default/files/documents/user-guide/nsidc-0051-v002-userguide.pdf"
HTTPS_HOST = "daacdata.apps.nsidc.org"
EARTHDATA_LOGIN_HELP = (
    "https://urs.earthdata.nasa.gov/ (cuenta gratuita), luego configurar "
    "~/.netrc segun https://nsidc.org/data/user-resources/help-center/programmatic-data-access-guide"
)
DATASET_VERSION = "NSIDC-0051 v2 (NASA Team), Nimbus-7 SMMR / DMSP SSM/I-SSMIS"

# Flags documentados en la guia de usuario (seccion 1.2, Parameter Range).
FLAG_POLE_HOLE = 251
FLAG_UNUSED = 252
FLAG_COAST = 253
FLAG_LAND = 254
MAX_VALID_RAW = 250
RAW_TO_FRACTION = 1.0 / 250.0  # 0..250 -> 0.0..1.0 (100% = 250)

HEMISPHERES = {
    "north": {"epsg": 3411, "sensor_prefix_default": "F17"},
    "south": {"epsg": 3412, "sensor_prefix_default": "F17"},
}

GRID_RESOLUTION_DEG = 2
SOURCE_CELL_SIZE_KM = 25

ROOT = Path(__file__).resolve().parent.parent
WORK_RAW_DIR = ROOT / "work" / "raw-dj" / "sea-ice"
OUT_DIR = ROOT / "public" / "data" / "sea-ice"
INDEX_PATH = ROOT / "public" / "data" / "dj-index.json"


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sensor_for_date(year: int, month: int) -> str:
    """Determina el prefijo de sensor segun el periodo documentado en la
    guia de usuario (Tabla 6)."""
    d = (year, month)
    if (1978, 10) <= d <= (1987, 8):
        return "N07"
    if (1987, 8) <= d <= (1991, 12):
        return "F08"
    if (1991, 12) <= d <= (1995, 9):
        return "F11"
    if (1995, 9) <= d <= (2007, 12):
        return "F13"
    if (2008, 1) <= d <= (2025, 12):
        return "F17"
    raise ValueError(
        f"{year}-{month:02d} esta fuera del periodo documentado de NSIDC-0051 "
        "(26 oct 1978 - 31 dic 2025)"
    )


def source_file_url(hemisphere: str, year: int, month: int) -> str:
    hem_code = "N" if hemisphere == "north" else "S"
    return (
        f"https://{HTTPS_HOST}/pub/DATASETS/NSIDC-0051/NSIDC-0051.002/"
        f"{year:04d}.{month:02d}.01/NSIDC0051_SEAICE_PS_{hem_code}25km_{year:04d}{month:02d}_v2.0.nc"
    )


def report_blocked_download(url: str, detail: str) -> None:
    print(
        "BLOQUEADO: no se pudo descargar el archivo NSIDC-0051 original sin "
        "iniciar sesion.\n"
        f"  URL intentada: {url}\n"
        f"  Detalle: {detail}\n"
        "  daacdata.apps.nsidc.org redirige a NASA Earthdata Login (OAuth) "
        "para cualquier descarga HTTPS anonima (verificado con curl -L).\n"
        f"  Para habilitar la descarga automatica, registrese en {EARTHDATA_LOGIN_HELP}\n"
        f"  Alternativamente, descargue el archivo manualmente desde {DATASET_PAGE} "
        "y pase su ruta con --input-north / --input-south.\n"
        "  No se genero ningun archivo de salida.",
        file=sys.stderr,
    )


def try_download_with_netrc(url: str, dest: Path) -> bool:
    try:
        n = netrc.netrc()
    except (FileNotFoundError, netrc.NetrcParseError):
        report_blocked_download(url, "No existe ~/.netrc con credenciales de Earthdata Login")
        return False

    auth = n.authenticators("urs.earthdata.nasa.gov")
    if auth is None:
        report_blocked_download(url, "~/.netrc no contiene una entrada para 'urs.earthdata.nasa.gov'")
        return False

    login, _, password = auth
    password_mgr = urllib.request.HTTPPasswordMgrWithPriorAuth()
    password_mgr.add_password(None, "urs.earthdata.nasa.gov", login, password, is_authenticated=True)
    opener = urllib.request.build_opener(
        urllib.request.HTTPBasicAuthHandler(password_mgr),
        urllib.request.HTTPCookieProcessor(),
    )
    req = urllib.request.Request(url, headers={"User-Agent": "earth-jukebox-prepare-script/1"})
    try:
        with opener.open(req, timeout=120) as resp:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as out:
                out.write(resp.read())
        return True
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        report_blocked_download(url, f"{type(exc).__name__}: {exc}")
        return False


def resolve_hemisphere_file(
    input_arg: str | None, hemisphere: str, year: int, month: int
) -> tuple[Path, str] | None:
    if input_arg:
        original = Path(input_arg).resolve()
        if not original.exists():
            raise FileNotFoundError(f"Archivo de entrada no encontrado: {original}")
        download_date = datetime.fromtimestamp(
            original.stat().st_mtime, tz=timezone.utc
        ).isoformat()
        return original, download_date

    cached = WORK_RAW_DIR / f"{hemisphere}_{year:04d}{month:02d}.nc"
    if cached.exists():
        download_date = datetime.fromtimestamp(cached.stat().st_mtime, tz=timezone.utc).isoformat()
        return cached, download_date

    url = source_file_url(hemisphere, year, month)
    ok = try_download_with_netrc(url, cached)
    if not ok:
        return None
    return cached, datetime.now(timezone.utc).isoformat()


def load_hemisphere_grid(
    nc_path: Path, hemisphere: str, year: int, month: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Devuelve (lon_2d, lat_2d, fraction_2d) con fraction_2d en [0,1] o NaN
    donde el pixel es tierra/costa/pole-hole/sin-dato."""
    sensor = sensor_for_date(year, month)
    var_name = f"{sensor}_ICECON"

    ds = nc.Dataset(nc_path)
    try:
        if var_name not in ds.variables:
            raise ValueError(
                f"No se encontro la variable '{var_name}' esperada para {year}-{month:02d} "
                f"en {nc_path.name} (variables disponibles: {list(ds.variables.keys())})"
            )
        var = ds.variables[var_name]
        if tuple(var.dimensions[-2:]) != ("y", "x"):
            raise ValueError(f"Dimensiones inesperadas para {var_name}: {var.dimensions}")

        raw = np.array(var[0, :, :], dtype=np.float64)  # (y, x)

        x = np.array(ds.variables["x"][:], dtype=np.float64)  # metros
        y = np.array(ds.variables["y"][:], dtype=np.float64)  # metros

        epsg = HEMISPHERES[hemisphere]["epsg"]
        transformer = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
        xx, yy = np.meshgrid(x, y)
        lon_2d, lat_2d = transformer.transform(xx, yy)

        fraction = np.full(raw.shape, np.nan)
        valid_ice = raw <= MAX_VALID_RAW
        fraction[valid_ice] = raw[valid_ice] * RAW_TO_FRACTION
        # Tierra, costa, pole hole, no-usado y cualquier otro codigo quedan
        # como NaN (excluidos), nunca como 0.0.

        return lon_2d, lat_2d, fraction
    finally:
        ds.close()


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
    """Acumula (en sum_grid/weight_grid, promedio ponderado por area) los
    pixeles validos de un hemisferio sobre la rejilla destino de 2 grados.
    Todos los pixeles fuente tienen la misma area fisica (25x25 km), por lo
    que el peso de cada pixel es simplemente 1 (ponderacion por area =
    uniforme dentro de un mismo producto de resolucion constante)."""
    valid = ~np.isnan(fraction_2d)
    lat_idx = np.clip(
        ((lat_2d[valid] - (-90)) / GRID_RESOLUTION_DEG).astype(np.int64), 0, len(lat_centers) - 1
    )
    lon_idx = np.clip(
        ((lon_2d[valid] - (-180)) / GRID_RESOLUTION_DEG).astype(np.int64), 0, len(lon_centers) - 1
    )
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
        lon_2d, lat_2d, fraction_2d = load_hemisphere_grid(path, hemisphere, year, month)
        accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)
        sources_meta[hemisphere] = {
            "file_url": source_file_url(hemisphere, year, month),
            "download_date_utc": download_date,
            "original_file_sha256": sha256_of_file(path),
            "sensor_variable": f"{sensor_for_date(year, month)}_ICECON",
            "epsg": HEMISPHERES[hemisphere]["epsg"],
        }

    out_grid = np.where(weight_grid > 0, np.divide(sum_grid, weight_grid, where=weight_grid > 0), np.nan)

    values = []
    for row in out_grid:
        for v in row:
            values.append(None if np.isnan(v) else round(float(v), 4))

    null_count = sum(1 for v in values if v is None)

    payload = {
        "dataset": DATASET_VERSION,
        "variable": "sea_ice_concentration",
        "period": f"{year}-{month:02d}",
        "units": "fraction (0.0-1.0) of valid ocean area covered by sea ice",
        "grid_resolution_deg": GRID_RESOLUTION_DEG,
        "source_grid": {
            "cell_size_km": SOURCE_CELL_SIZE_KM,
            "projection": "polar stereographic (EPSG:3411 north, EPSG:3412 south)",
        },
        "grid_shape": {"lat": len(lat_centers), "lon": len(lon_centers)},
        "value_order": "row-major: fila=lat (ascendente), columna=lon (ascendente); indice = lat_idx * n_lon + lon_idx",
        "axes": {
            "lat_centers": [round(float(v), 4) for v in lat_centers],
            "lon_centers": [round(float(v), 4) for v in lon_centers],
        },
        "flags_excluded_from_average": {
            "pole_hole": FLAG_POLE_HOLE,
            "unused": FLAG_UNUSED,
            "coast": FLAG_COAST,
            "land": FLAG_LAND,
            "note": "tierra/costa/pole-hole/sin-dato se excluyen del promedio; nunca se cuentan como 0% de hielo",
        },
        "hemispheres_included": list(sources_meta.keys()),
        "null_count": null_count,
        "cell_count": len(values),
        "values": values,
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
    update_index_section(INDEX_PATH, "sea_ice", files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-north", help="Ruta a un NetCDF NSIDC-0051 hemisferio norte local", default=None)
    parser.add_argument("--input-south", help="Ruta a un NetCDF NSIDC-0051 hemisferio sur local", default=None)
    parser.add_argument("--year", type=int, default=2023)
    parser.add_argument("--month", type=int, default=1)
    args = parser.parse_args()

    north_file = resolve_hemisphere_file(args.input_north, "north", args.year, args.month)
    south_file = resolve_hemisphere_file(args.input_south, "south", args.year, args.month)

    if north_file is None and south_file is None:
        print("No se pudo obtener ningun archivo (norte ni sur). Abortando sin generar salida.", file=sys.stderr)
        raise SystemExit(1)

    export_month(north_file, south_file, args.year, args.month)
    rebuild_dj_index()


if __name__ == "__main__":
    main()
