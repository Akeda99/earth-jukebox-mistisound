#!/usr/bin/env python3
"""Exporta una rejilla mensual de precipitacion (IMERG Final Run, GPM) a JSON
compacto de 2 grados para Earth Jukebox.

Fuente de datos: GPM IMERG Final Precipitation L3 1 month 0.1x0.1 grados,
version 07 (GPM_3IMERGM.07), producido por NASA/JAXA y distribuido por
GES DISC.
  - Pagina del producto:    https://gpm.nasa.gov/data/imerg
  - Pagina del dataset:     https://disc.gsfc.nasa.gov/datasets/GPM_3IMERGM_07/summary
  - Archivo HDF5 (ejemplo): https://gpm1.gesdisc.eosdis.nasa.gov/data/GPM_L3/GPM_3IMERGM.07/{YYYY}/3B-MO.MS.MRG.3IMERG.{YYYYMMDD}-S000000-E235959.{MM}.V07B.HDF5

ACCESO REAL VERIFICADO (ver docs/dj-data-sources.md): la descarga por HTTPS
de GES DISC redirige (401 -> OAuth) a https://urs.earthdata.nasa.gov/ y
exige una cuenta gratuita de NASA Earthdata Login autorizada para la
aplicacion "GES DISC". Este script NO intenta sortear ese login. Solo
descarga automaticamente si el usuario ya tiene configuradas sus propias
credenciales en ~/.netrc (mecanismo oficial documentado por NASA para
herramientas de linea de comandos como wget/curl). Si no hay credenciales
disponibles, el script reporta el bloqueo exacto y se detiene sin generar
ningun archivo de salida.

Alternativamente acepta un archivo HDF5/NetCDF4 ya descargado manualmente
por el usuario via --input.

Este script:
  1. Resuelve el archivo fuente (local con --input, cache en work/raw-dj/,
     o intento de descarga via .netrc).
  2. Abre el grupo "Grid" del archivo IMERG con netCDF4 y lee la variable
     "precipitation" SIN volver a aplicar ningun factor de escala (se deja
     que netCDF4 aplique scale_factor/_FillValue una sola vez si existen).
  3. Verifica las unidades originales (mm/h, tasa) para no mezclarlas nunca
     con acumulados (mm/mes).
  4. Agrega el campo nativo de 0.1 grados (3600 lon x 1800 lat) a la rejilla
     de 2 grados (180 lon x 90 lat) promediando con peso de area
     (cos(lat) de cada subcelda de 0.1 grados), exigiendo una fraccion
     minima de subceldas validas por celda de salida; si no se alcanza, la
     celda de salida se marca null.
  5. Exporta un JSON por mes en public/data/precipitation/AAAA-MM.json.

No se inventan datos: si falta el archivo fuente y no hay forma de
descargarlo sin sortear el login, el script termina con un error explicito
en vez de producir un JSON simulado o incompleto.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import netrc
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import netCDF4 as nc
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dj_index_common import update_index_section  # noqa: E402

PRODUCT_PAGE = "https://gpm.nasa.gov/data/imerg"
DATASET_PAGE = "https://disc.gsfc.nasa.gov/datasets/GPM_3IMERGM_07/summary"
GES_DISC_HOST = "gpm1.gesdisc.eosdis.nasa.gov"
EARTHDATA_LOGIN_HELP = (
    "https://urs.earthdata.nasa.gov/ (cuenta gratuita) y autorizar la "
    "aplicacion 'GES DISC' en el perfil, luego configurar ~/.netrc segun "
    "https://disc.gsfc.nasa.gov/data-access"
)
DATASET_VERSION = "GPM IMERG Final Run V07 (GPM_3IMERGM.07)"
SOURCE_GRID_RESOLUTION_DEG = 0.1
TARGET_GRID_RESOLUTION_DEG = 2
MIN_COVERAGE_FRACTION = 0.5  # fraccion minima de subceldas validas por celda de salida

ROOT = Path(__file__).resolve().parent.parent
WORK_RAW_DIR = ROOT / "work" / "raw-dj" / "precipitation"
OUT_DIR = ROOT / "public" / "data" / "precipitation"
INDEX_PATH = ROOT / "public" / "data" / "dj-index.json"


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def source_file_url(year: int, month: int) -> str:
    """URL del archivo mensual IMERG V07B para el primer dia del mes.

    El nombre exacto de archivo de GES DISC usa el dia 01 del mes como
    fecha nominal del producto mensual.
    """
    return (
        f"https://{GES_DISC_HOST}/data/GPM_L3/GPM_3IMERGM.07/{year:04d}/"
        f"3B-MO.MS.MRG.3IMERG.{year:04d}{month:02d}01-S000000-E235959.{month:02d}.V07B.HDF5"
    )


def report_blocked_download(url: str, detail: str) -> None:
    print(
        "BLOQUEADO: no se pudo descargar el archivo IMERG original sin "
        "iniciar sesion.\n"
        f"  URL intentada: {url}\n"
        f"  Detalle: {detail}\n"
        "  GES DISC redirige a NASA Earthdata Login (OAuth) para cualquier "
        "descarga HTTPS anonima (verificado: HTTP 401 -> redireccion a "
        "urs.earthdata.nasa.gov).\n"
        f"  Para habilitar la descarga automatica, registrese en {EARTHDATA_LOGIN_HELP}\n"
        "  Alternativamente, descargue el archivo manualmente desde "
        f"{DATASET_PAGE} y pase su ruta con --input.\n"
        "  No se genero ningun archivo de salida.",
        file=sys.stderr,
    )


def try_download_with_netrc(url: str, dest: Path) -> bool:
    """Intenta descargar usando credenciales ya configuradas por el usuario
    en ~/.netrc (mecanismo oficial de NASA Earthdata para linea de comandos).
    Devuelve False (sin excepcion) si no hay credenciales o si el servidor
    rechaza la autenticacion; en ese caso no se escribe ningun archivo.
    """
    try:
        n = netrc.netrc()
    except (FileNotFoundError, netrc.NetrcParseError):
        report_blocked_download(url, "No existe ~/.netrc con credenciales de Earthdata Login")
        return False

    auth = n.authenticators("urs.earthdata.nasa.gov")
    if auth is None:
        report_blocked_download(
            url, "~/.netrc no contiene una entrada para 'urs.earthdata.nasa.gov'"
        )
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
    except (urllib.error.HTTPError, urllib.error.URLError, http.client.HTTPException) as exc:
        report_blocked_download(url, f"{type(exc).__name__}: {exc}")
        return False


def resolve_input_file(input_arg: str | None, year: int, month: int) -> tuple[Path, str]:
    if input_arg:
        original = Path(input_arg).resolve()
        if not original.exists():
            raise FileNotFoundError(f"Archivo de entrada no encontrado: {original}")
        download_date = datetime.fromtimestamp(
            original.stat().st_mtime, tz=timezone.utc
        ).isoformat()
        return original, download_date

    cached = WORK_RAW_DIR / f"3IMERGM.{year:04d}{month:02d}.HDF5"
    if cached.exists():
        download_date = datetime.fromtimestamp(cached.stat().st_mtime, tz=timezone.utc).isoformat()
        return cached, download_date

    url = source_file_url(year, month)
    ok = try_download_with_netrc(url, cached)
    if not ok:
        raise SystemExit(1)
    return cached, datetime.now(timezone.utc).isoformat()


def find_precipitation_variable(ds: nc.Dataset):
    """Localiza la variable 'precipitation' dentro del grupo 'Grid' de un
    archivo IMERG. Lanza error explicito si la estructura no es la
    esperada (en vez de adivinar)."""
    if "Grid" not in ds.groups:
        raise ValueError("No se encontro el grupo 'Grid' en el archivo IMERG")
    grid = ds.groups["Grid"]
    if "precipitation" not in grid.variables:
        raise ValueError("No se encontro la variable 'precipitation' en el grupo 'Grid'")
    return grid


def aggregate_to_target_grid(
    lon_src: np.ndarray, lat_src: np.ndarray, data: np.ma.MaskedArray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Agrega una rejilla fuente de 0.1 grados (lon, lat) a la rejilla
    destino de 2 grados, usando promedio ponderado por area (cos(lat) de
    cada subcelda). data tiene forma (n_lon_src, n_lat_src).

    Devuelve (lat_out_centers, lon_out_centers, values_2d[lat_out, lon_out])
    con np.nan donde la cobertura valida es insuficiente.
    """
    n_lon_src = lon_src.shape[0]
    n_lat_src = lat_src.shape[0]
    factor = round(TARGET_GRID_RESOLUTION_DEG / SOURCE_GRID_RESOLUTION_DEG)

    if n_lon_src % factor != 0 or n_lat_src % factor != 0:
        raise ValueError(
            f"La rejilla fuente ({n_lon_src}x{n_lat_src}) no es divisible exactamente "
            f"por el factor de agregacion {factor}"
        )

    n_lon_out = n_lon_src // factor
    n_lat_out = n_lat_src // factor

    mask = np.ma.getmaskarray(data)
    filled = data.filled(0.0)
    weights_lat = np.cos(np.deg2rad(lat_src))  # (n_lat_src,)

    lat_out_centers = np.empty(n_lat_out)
    lon_out_centers = np.empty(n_lon_out)
    out = np.full((n_lat_out, n_lon_out), np.nan)

    for lat_i in range(n_lat_out):
        lat_slice = slice(lat_i * factor, (lat_i + 1) * factor)
        lat_out_centers[lat_i] = round(float(np.mean(lat_src[lat_slice])), 4)
        w_lat = weights_lat[lat_slice]  # (factor,)
        for lon_i in range(n_lon_out):
            lon_slice = slice(lon_i * factor, (lon_i + 1) * factor)
            if lat_i == 0:
                lon_out_centers[lon_i] = round(float(np.mean(lon_src[lon_slice])), 4)

            block_mask = mask[lon_slice, lat_slice]  # (factor, factor)
            block_vals = filled[lon_slice, lat_slice]
            # w_lat varia a lo largo del eje lat (axis=1 de este bloque, ya
            # que block_mask tiene forma (lon, lat)); se expande sobre el
            # eje lon (axis=0) que no afecta el peso por coslat.
            block_w = np.broadcast_to(w_lat[np.newaxis, :], block_mask.shape)

            valid = ~block_mask
            n_valid = int(np.sum(valid))
            coverage = n_valid / block_mask.size
            if coverage < MIN_COVERAGE_FRACTION or n_valid == 0:
                continue
            wsum = np.sum(block_w[valid])
            if wsum <= 0:
                continue
            out[lat_i, lon_i] = float(np.sum(block_vals[valid] * block_w[valid]) / wsum)

    return lat_out_centers, lon_out_centers, out


def export_month(src_path: Path, year: int, month: int, download_date: str) -> Path:
    ds = nc.Dataset(src_path)
    try:
        grid = find_precipitation_variable(ds)
        var = grid.variables["precipitation"]

        units = getattr(var, "units", "").strip()
        if not units:
            raise ValueError("La variable 'precipitation' no declara unidades; no se asume nada")
        if "mm/hr" not in units.lower() and "mm/h" not in units.lower():
            raise ValueError(
                f"Unidades inesperadas para 'precipitation': '{units}'. Se esperaba una "
                "tasa en mm/h; el script se detiene para no mezclar tasa y acumulado."
            )
        out_units = "mm/h"

        lon = grid.variables["lon"][:]
        lat = grid.variables["lat"][:]

        expected_lon_n = round(360 / SOURCE_GRID_RESOLUTION_DEG)
        expected_lat_n = round(180 / SOURCE_GRID_RESOLUTION_DEG)
        if lon.shape[0] != expected_lon_n or lat.shape[0] != expected_lat_n:
            raise ValueError(
                f"Rejilla IMERG inesperada: lon={lon.shape[0]} lat={lat.shape[0]} "
                f"(se esperaba {expected_lon_n}x{expected_lat_n} para 0.1 grados)"
            )

        data = var[0, :, :]  # dims (time, lon, lat); netCDF4 aplica auto mask/scale
        if not np.ma.isMaskedArray(data):
            data = np.ma.masked_invalid(data)

        lat_out, lon_out, values_2d = aggregate_to_target_grid(lon, lat, data)

        values = []
        for row in values_2d:  # row-major: lat asciende, luego lon asciende
            for v in row:
                values.append(None if np.isnan(v) else round(float(v), 4))

        null_count = sum(1 for v in values if v is None)
        checksum = sha256_of_file(src_path)

        payload = {
            "dataset": DATASET_VERSION,
            "variable": "precipitation",
            "quantity_kind": "rate",
            "period": f"{year}-{month:02d}",
            "units": out_units,
            "source_grid_resolution_deg": SOURCE_GRID_RESOLUTION_DEG,
            "grid_resolution_deg": TARGET_GRID_RESOLUTION_DEG,
            "grid_shape": {"lat": len(lat_out), "lon": len(lon_out)},
            "value_order": "row-major: fila=lat (ascendente), columna=lon (ascendente); indice = lat_idx * n_lon + lon_idx",
            "axes": {
                "lat_centers": [round(float(v), 4) for v in lat_out],
                "lon_centers": [round(float(v), 4) for v in lon_out],
            },
            "aggregation": {
                "method": "promedio ponderado por area (coslat) de subceldas de 0.1 grados",
                "min_coverage_fraction": MIN_COVERAGE_FRACTION,
            },
            "null_count": null_count,
            "cell_count": len(values),
            "values": values,
            "source": {
                "product_page": PRODUCT_PAGE,
                "dataset_page": DATASET_PAGE,
                "file_url": source_file_url(year, month),
                "download_date_utc": download_date,
                "original_file_sha256": checksum,
            },
        }

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        out_path = OUT_DIR / f"{year}-{month:02d}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)

        print(
            f"Exportado {out_path} ({len(values)} celdas, {null_count} sin cobertura suficiente)",
            file=sys.stderr,
        )
        return out_path
    finally:
        ds.close()


def rebuild_dj_index() -> None:
    """Actualiza SOLO la seccion 'precipitation' de public/data/dj-index.json
    (archivo propio de este conjunto de preparadores, separado del
    manifest.json compartido). Lista unicamente archivos que realmente
    existen."""
    files = []
    if OUT_DIR.exists():
        for path in sorted(OUT_DIR.glob("*.json")):
            rel = path.relative_to(INDEX_PATH.parent).as_posix()
            files.append({"path": rel, "size_bytes": path.stat().st_size})
    update_index_section(INDEX_PATH, "precipitation", files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Ruta a un archivo HDF5/NetCDF4 IMERG local", default=None)
    parser.add_argument("--year", type=int, default=2023)
    parser.add_argument("--month", type=int, default=1)
    args = parser.parse_args()

    src_path, download_date = resolve_input_file(args.input, args.year, args.month)
    export_month(src_path, args.year, args.month, download_date)
    rebuild_dj_index()


if __name__ == "__main__":
    main()
