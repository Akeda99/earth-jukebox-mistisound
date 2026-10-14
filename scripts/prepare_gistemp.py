#!/usr/bin/env python3
"""Exporta rejillas mensuales de GISTEMP (anomalia de temperatura) a JSON
para Earth Jukebox, para un rango de anios (por defecto 2000-2025).

Fuente de datos: GISTEMP v4 (NASA GISS), rejilla 1200km-smoothed,
resolucion 2 grados, combinando GHCNv4 (tierra) y ERSSTv5 (oceano).
  - Pagina del dataset: https://data.giss.nasa.gov/gistemp/
  - Archivo NetCDF:     https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz

Este script:
  1. Descarga el .nc.gz original UNA SOLA VEZ (o usa un archivo local con
     --input), lo descomprime UNA SOLA VEZ y calcula su checksum SHA-256
     UNA SOLA VEZ, sin repetir ninguno de estos pasos por mes exportado.
  2. Abre el NetCDF una sola vez con netCDF4, dejando que la libreria
     aplique "auto mask and scale" (scale_factor / _FillValue) una sola vez
     por lectura; no se reaplica ningun factor de escala manualmente.
  3. Lee la unidad real de la variable desde el atributo `units` del
     NetCDF (no se asume "K" ni "degC"): si el atributo no existe, el
     script falla en vez de adivinar. Nota de equivalencia: una anomalia
     en Kelvin y la misma anomalia en grados Celsius tienen igual
     magnitud, porque son diferencias de temperatura (delta), no
     temperaturas absolutas; solo cambia el nombre de la unidad.
  4. Verifica que las dimensiones de la variable principal sean
     (time, lat, lon), que lat/lon estan en el orden esperado y que la
     rejilla sea de 90x180 celdas (2 grados).
  5. Para cada (anio, mes) en el rango pedido que exista en la dimension
     `time` del NetCDF, exporta un JSON con los ejes como centros de
     celda, valores aplanados en orden fila-mayor y null donde el dato
     original esta ausente (_FillValue). Un (anio, mes) fuera del rango
     cubierto por el archivo fuente se omite (se avisa por stderr), nunca
     se inventa un archivo para el.
  6. Regenera public/data/manifest.json listando unicamente los archivos
     JSON que realmente existen en public/data/gistemp/, con su periodo y
     ruta reales (parseados del propio nombre de archivo, no de una lista
     calculada aparte).

No se inventan datos: si falta el archivo fuente, si ningun mes del rango
pedido existe en el NetCDF, o si las dimensiones/unidades no son las
esperadas, el script termina con un error en vez de producir JSON
incompleto, vacio o simulado.
"""

from __future__ import annotations

import argparse
import hashlib
import gzip
import json
import math
import re
import shutil
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import netCDF4 as nc
import numpy as np

SOURCE_DATASET_PAGE = "https://data.giss.nasa.gov/gistemp/"
SOURCE_NC_GZ_URL = (
    "https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz"
)
BASELINE_PERIOD = "1951-1980"
SMOOTHING_RADIUS_KM = 1200
GRID_RESOLUTION_DEG = 2
DATASET_VERSION = "GISTEMP v4 (GHCNv4 land + ERSSTv5 ocean)"

ROOT = Path(__file__).resolve().parent.parent
WORK_RAW_DIR = ROOT / "work" / "raw"
OUT_DIR = ROOT / "public" / "data" / "gistemp"
MANIFEST_PATH = ROOT / "public" / "data" / "manifest.json"

PERIOD_FILENAME_RE = re.compile(r"^(\d{4})-(\d{2})\.json$")


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download_source(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Descargando {SOURCE_NC_GZ_URL} -> {dest}", file=sys.stderr)
    req = urllib.request.Request(
        SOURCE_NC_GZ_URL, headers={"User-Agent": "earth-jukebox-prepare-script/1"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out)


def ensure_decompressed(path: Path) -> Path:
    """Si path es .gz, lo descomprime junto a si mismo (una sola vez, se
    reutiliza si ya existe) y devuelve el .nc."""
    if path.suffix != ".gz":
        return path
    nc_path = path.with_suffix("")
    if nc_path.exists():
        return nc_path
    with gzip.open(path, "rb") as f_in, open(nc_path, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)
    return nc_path


def resolve_input_file(input_arg: str | None) -> tuple[Path, Path, str]:
    """Devuelve (ruta_nc_lista_para_abrir, ruta_archivo_original, fecha_descarga_iso).

    La descarga/descompresion ocurre a lo sumo una vez por ejecucion,
    independientemente de cuantos meses se exporten despues.
    """
    if input_arg:
        original = Path(input_arg).resolve()
        if not original.exists():
            raise FileNotFoundError(f"Archivo de entrada no encontrado: {original}")
        download_date = datetime.fromtimestamp(
            original.stat().st_mtime, tz=timezone.utc
        ).isoformat()
        print(
            f"Usando archivo local provisto: {original} "
            f"(fecha de descarga desconocida; se usa mtime del archivo: {download_date})",
            file=sys.stderr,
        )
        nc_path = ensure_decompressed(original)
        return nc_path, original, download_date

    gz_path = WORK_RAW_DIR / "gistemp1200_GHCNv4_ERSSTv5.nc.gz"
    if not gz_path.exists():
        download_source(gz_path)
        download_date = datetime.now(timezone.utc).isoformat()
    else:
        print(f"Reutilizando archivo ya descargado: {gz_path}", file=sys.stderr)
        download_date = datetime.fromtimestamp(
            gz_path.stat().st_mtime, tz=timezone.utc
        ).isoformat()
    nc_path = ensure_decompressed(gz_path)
    return nc_path, gz_path, download_date


def months_in_range(start_year: int, end_year: int):
    for year in range(start_year, end_year + 1):
        for month in range(1, 13):
            yield year, month


def read_units(var) -> str:
    """Lee la unidad real desde el atributo `units` del NetCDF. No se
    asume K ni degC: si el atributo no esta presente, falla."""
    units = getattr(var, "units", None)
    if not units:
        raise ValueError(
            "La variable 'tempanomaly' no tiene atributo 'units' en el NetCDF; "
            "no se asume una unidad por defecto."
        )
    return str(units).strip()


def export_all_months(
    nc_path: Path,
    start_year: int,
    end_year: int,
    checksum: str,
    download_date: str,
) -> list[Path]:
    ds = nc.Dataset(nc_path)
    exported: list[Path] = []
    try:
        if "tempanomaly" not in ds.variables:
            raise ValueError("Variable 'tempanomaly' no encontrada en el NetCDF")
        var = ds.variables["tempanomaly"]

        if var.dimensions != ("time", "lat", "lon"):
            raise ValueError(
                f"Orden de dimensiones inesperado para tempanomaly: {var.dimensions} "
                "(se esperaba ('time', 'lat', 'lon'))"
            )

        lat = ds.variables["lat"][:]
        lon = ds.variables["lon"][:]

        if not np.all(np.diff(lat) > 0):
            raise ValueError("Se esperaba 'lat' en orden ascendente")
        if not np.all(np.diff(lon) > 0):
            raise ValueError("Se esperaba 'lon' en orden ascendente")

        expected_lat_n = round(180 / GRID_RESOLUTION_DEG)
        expected_lon_n = round(360 / GRID_RESOLUTION_DEG)
        if lat.shape[0] != expected_lat_n or lon.shape[0] != expected_lon_n:
            raise ValueError(
                f"Rejilla inesperada: lat={lat.shape[0]} lon={lon.shape[0]} "
                f"(se esperaba {expected_lat_n}x{expected_lon_n} para {GRID_RESOLUTION_DEG} grados)"
            )

        units = read_units(var)

        time_var = ds.variables["time"]
        dates = nc.num2date(time_var[:], time_var.units, only_use_cftime_datetimes=False)
        index_by_period = {}
        for i, d in enumerate(dates):
            index_by_period[(d.year, d.month)] = i

        lat_centers = [round(float(v), 4) for v in lat]
        lon_centers = [round(float(v), 4) for v in lon]

        OUT_DIR.mkdir(parents=True, exist_ok=True)

        skipped = []
        for year, month in months_in_range(start_year, end_year):
            time_idx = index_by_period.get((year, month))
            if time_idx is None:
                skipped.append(f"{year}-{month:02d}")
                continue

            # netCDF4 decodifica automaticamente scale_factor y _FillValue al
            # indexar la variable (auto mask and scale). NO se vuelve a
            # aplicar ningun factor de escala manualmente aqui.
            data = var[time_idx, :, :]
            if not np.ma.isMaskedArray(data):
                data = np.ma.masked_invalid(data)

            mask = np.ma.getmaskarray(data)
            filled = data.filled(np.nan)

            values = []
            for row_idx in range(filled.shape[0]):
                for col_idx in range(filled.shape[1]):
                    if mask[row_idx, col_idx] or not math.isfinite(filled[row_idx, col_idx]):
                        values.append(None)
                    else:
                        values.append(round(float(filled[row_idx, col_idx]), 4))

            null_count = sum(1 for v in values if v is None)
            if null_count == len(values):
                # Una rejilla completamente vacia no es un dataset valido:
                # se omite en vez de exportarse como JSON sin informacion.
                skipped.append(f"{year}-{month:02d} (vacio)")
                continue

            payload = {
                "dataset": DATASET_VERSION,
                "variable": "tempanomaly",
                "period": f"{year}-{month:02d}",
                "units": units,
                "units_note": (
                    "Anomalia (delta de temperatura), no temperatura absoluta: "
                    "la misma magnitud en K que en grados Celsius."
                ),
                "baseline_period": BASELINE_PERIOD,
                "smoothing_radius_km": SMOOTHING_RADIUS_KM,
                "grid_resolution_deg": GRID_RESOLUTION_DEG,
                "grid_shape": {"lat": lat.shape[0], "lon": lon.shape[0]},
                "value_order": "row-major: fila=lat (ascendente), columna=lon (ascendente); indice = lat_idx * n_lon + lon_idx",
                "axes": {"lat_centers": lat_centers, "lon_centers": lon_centers},
                "null_count": null_count,
                "cell_count": len(values),
                "values": values,
                "source": {
                    "dataset_page": SOURCE_DATASET_PAGE,
                    "file_url": SOURCE_NC_GZ_URL,
                    "download_date_utc": download_date,
                    "original_file_sha256": checksum,
                },
            }

            out_path = OUT_DIR / f"{year}-{month:02d}.json"
            # separators compactos: JSON sin espacios extra y sin NaN/Infinity
            # (allow_nan=False hace fallar explicitamente si algun valor no
            # serializable se filtrara, en vez de escribir "NaN" invalido).
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            exported.append(out_path)

        if not exported:
            raise ValueError(
                f"Ningun mes del rango {start_year}-{end_year} existe en el NetCDF "
                f"(rango disponible: {dates[0]} .. {dates[-1]})"
            )

        if skipped:
            print(
                f"Omitidos (no estan en el NetCDF fuente o quedaron vacios): {', '.join(skipped)}",
                file=sys.stderr,
            )
        print(f"Exportados {len(exported)} archivo(s) en {OUT_DIR}", file=sys.stderr)
        return exported
    finally:
        ds.close()


def rebuild_manifest() -> None:
    """Lista unicamente los archivos JSON que realmente existen en
    public/data/gistemp/, con su periodo parseado del propio nombre de
    archivo (no de una lista calculada aparte, para evitar manifest/datos
    desincronizados)."""
    files = []
    if OUT_DIR.exists():
        for path in sorted(OUT_DIR.glob("*.json")):
            match = PERIOD_FILENAME_RE.match(path.name)
            if not match:
                continue
            period = f"{match.group(1)}-{match.group(2)}"
            rel = path.relative_to(MANIFEST_PATH.parent).as_posix()
            files.append({"period": period, "path": rel, "size_bytes": path.stat().st_size})
    manifest = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "files": files,
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"Manifiesto actualizado: {MANIFEST_PATH} ({len(files)} archivo(s))", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        help="Ruta a un archivo .nc o .nc.gz local (si se omite, se descarga desde NASA GISS)",
        default=None,
    )
    parser.add_argument("--start-year", type=int, default=2000)
    parser.add_argument("--end-year", type=int, default=2025)
    args = parser.parse_args()

    if args.start_year > args.end_year:
        raise ValueError("--start-year no puede ser mayor que --end-year")

    nc_path, original_path, download_date = resolve_input_file(args.input)
    # El checksum del archivo original se calcula una sola vez para todo el
    # rango exportado, no por cada mes.
    checksum = sha256_of_file(original_path)
    export_all_months(nc_path, args.start_year, args.end_year, checksum, download_date)
    rebuild_manifest()


if __name__ == "__main__":
    main()
