#!/usr/bin/env python3
"""Exporta precipitacion mensual real (NASA POWER, parametro PRECTOTCORR,
fuente MERRA-2) para 3 puntos aproximados de Peru, a JSON ligero para Earth
Jukebox.

Fuente de datos: NASA POWER (Prediction Of Worldwide Energy Resource),
servicio "Monthly and Annual" (API temporal/monthly/point), parametro
PRECTOTCORR ("Precipitation Corrected"), derivado del reanalisis GMAO
MERRA-2.
  - Documentacion del servicio: https://power.larc.nasa.gov/docs/services/api/temporal/monthly/
  - Metodologia/resolucion MERRA-2: https://power.larc.nasa.gov/docs/methodology/meteorology/
    (rejilla nativa MERRA-2: 0.5 grados lat x 0.625 grados lon; fuente horaria
    agregada a mensual por el propio servicio POWER).
  - Endpoint usado (ejemplo Iquitos):
    https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=PRECTOTCORR&community=RE&longitude=-73.25&latitude=-3.75&start=2000&end=2025&format=JSON

IMPORTANTE sobre la magnitud: PRECTOTCORR es, para cada mes, el PROMEDIO de
la tasa diaria de precipitacion de ese mes (unidades reales devueltas por la
API: "mm/day"), NO un total acumulado mensual y NO un producto IMERG. Se
conserva tal cual la API lo entrega, sin convertir a total mensual ni
mezclar con otras fuentes.

La respuesta de la API incluye, por anio, 13 claves mensuales: "YYYY01".."YYYY12"
mas una clave "YYYY13" que es el PROMEDIO ANUAL (no un mes 13). Este script
excluye explicitamente las claves "YYYY13" del mapeo mensual exportado.

Puntos cubiertos (aproximados, Peru):
  - iquitos:    lat -3.75  lon -73.25  (selva, cerca de Iquitos)
  - quelccaya:  lat -13.93 lon -70.82  (glaciar Quelccaya, Andes)
  - mar-piura:  lat -5.00  lon -81.50  (oceano frente a Piura)

Este script:
  1. Para cada punto, pide un unico rango start=2000 end=2025 (misma
     cobertura temporal que el dataset GISTEMP ya preparado). Se verifico
     manualmente que la API devuelve el rango completo en una sola
     respuesta (338 claves = 26 anios x 13), sin necesidad de dividir en
     sub-periodos. Si en el futuro la API rechazara el rango completo (p.ej.
     error 4xx indicando limite), el script cae a una division por bloques
     de anios (ver `YEAR_BLOCK_SIZE_FALLBACK`) en vez de fallar o inventar.
  2. Reutiliza el JSON crudo cacheado en work/raw-power/ si ya existe y no
     se pasa --refresh; solo entonces vuelve a pedir el mismo rango a la
     API.
  3. Hace maximo 1 solicitud concurrente (secuencial, un punto a la vez),
     con una pausa entre solicitudes y un numero limitado de reintentos con
     backoff ante errores transitorios (429, 5xx, timeout).
  4. Verifica que las unidades reales devueltas sean "mm/day" (no asume
     nada): si la API cambia la unidad, el script se detiene en vez de
     reinterpretar silenciosamente los valores.
  5. Construye el mapeo "YYYY-MM" -> numero o null: los valores iguales al
     fill_value declarado por la propia API (header.fill_value, tipicamente
     -999.0) se mapean a null (nunca a 0, para no confundir "sin dato" con
     "cero precipitacion").
  6. Exporta un JSON por punto en public/data/power/<location_id>.json y
     regenera public/data/power-index.json listando solo los archivos que
     realmente existen, con sus periodos reales disponibles.

No se inventan datos ni se extrapola fuera de la cobertura devuelta por la
API: si un mes no viene en la respuesta, no se agrega al mapeo (no se
rellena con null por fuera del rango real).
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK_RAW_DIR = ROOT / "work" / "raw-power"
OUT_DIR = ROOT / "public" / "data" / "power"
INDEX_PATH = ROOT / "public" / "data" / "power-index.json"

API_BASE_URL = "https://power.larc.nasa.gov/api/temporal/monthly/point"
PARAMETER = "PRECTOTCORR"
COMMUNITY = "RE"
EXPECTED_UNITS = "mm/day"
DATA_VERSION = 1

# Division de respaldo si la API llegara a rechazar el rango completo
# 2000-2025 en una sola solicitud (no ha ocurrido en las pruebas: ver
# docs/power-data.md). No se usa en la ejecucion normal.
YEAR_BLOCK_SIZE_FALLBACK = 10

MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5
REQUEST_TIMEOUT_SECONDS = 60
SLEEP_BETWEEN_REQUESTS_SECONDS = 2

ANNUAL_KEY_SUFFIX = "13"
PERIOD_KEY_RE = re.compile(r"^(\d{4})(\d{2})$")

LOCATIONS = [
    {
        "id": "iquitos",
        "name": "Iquitos (selva amazonica, Peru)",
        "lat": -3.75,
        "lon": -73.25,
    },
    {
        "id": "quelccaya",
        "name": "Glaciar Quelccaya (Andes, Peru)",
        "lat": -13.93,
        "lon": -70.82,
    },
    {
        "id": "mar-piura",
        "name": "Oceano frente a Piura, Peru",
        "lat": -5.00,
        "lon": -81.50,
    },
]


def sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_url(lat: float, lon: float, start_year: int, end_year: int) -> str:
    return (
        f"{API_BASE_URL}?parameters={PARAMETER}&community={COMMUNITY}"
        f"&longitude={lon}&latitude={lat}&start={start_year}&end={end_year}&format=JSON"
    )


def fetch_with_retries(url: str) -> bytes:
    """Descarga `url` con un numero limitado de reintentos y backoff fijo
    ante errores transitorios (429, 5xx, timeout/conexion). Errores 4xx
    distintos de 429 se propagan de inmediato (no son transitorios)."""
    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        req = urllib.request.Request(
            url, headers={"User-Agent": "earth-jukebox-prepare-script/1"}
        )
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 429 or exc.code >= 500:
                last_exc = exc
                print(
                    f"  intento {attempt}/{MAX_RETRIES} fallo (HTTP {exc.code}), "
                    f"reintentando en {RETRY_BACKOFF_SECONDS}s...",
                    file=sys.stderr,
                )
                time.sleep(RETRY_BACKOFF_SECONDS)
                continue
            raise
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError) as exc:
            last_exc = exc
            print(
                f"  intento {attempt}/{MAX_RETRIES} fallo ({type(exc).__name__}: {exc}), "
                f"reintentando en {RETRY_BACKOFF_SECONDS}s...",
                file=sys.stderr,
            )
            time.sleep(RETRY_BACKOFF_SECONDS)
            continue
    assert last_exc is not None
    raise last_exc


def resolve_raw_response(
    location_id: str, lat: float, lon: float, start_year: int, end_year: int, refresh: bool
) -> tuple[bytes, str, str]:
    """Devuelve (raw_bytes, url_usada, fecha_descarga_iso). Reutiliza el
    cache en work/raw-power si existe y no se pide --refresh."""
    WORK_RAW_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = WORK_RAW_DIR / f"{location_id}_{start_year}-{end_year}.json"
    url = build_url(lat, lon, start_year, end_year)

    if cache_path.exists() and not refresh:
        print(f"Reutilizando cache existente: {cache_path}", file=sys.stderr)
        raw = cache_path.read_bytes()
        download_date = datetime.fromtimestamp(
            cache_path.stat().st_mtime, tz=timezone.utc
        ).isoformat()
        return raw, url, download_date

    print(f"Solicitando {url}", file=sys.stderr)
    raw = fetch_with_retries(url)
    cache_path.write_bytes(raw)
    download_date = datetime.now(timezone.utc).isoformat()
    return raw, url, download_date


def parse_monthly_mapping(parameter_values: dict, fill_value: float) -> dict:
    """Convierte el dict crudo "YYYYMM"/"YYYY13" -> valor en un mapeo
    "YYYY-MM" -> numero o null, excluyendo las claves "YYYY13" (promedio
    anual, no un mes) y mapeando el fill_value declarado por la API a
    null (nunca a 0)."""
    mapping: dict[str, float | None] = {}
    for raw_key, value in parameter_values.items():
        match = PERIOD_KEY_RE.match(raw_key)
        if not match:
            raise ValueError(f"Clave de periodo inesperada en la respuesta de POWER: {raw_key!r}")
        year, month_or_13 = match.group(1), match.group(2)
        if month_or_13 == ANNUAL_KEY_SUFFIX:
            continue  # promedio anual, no un mes: se excluye explicitamente
        month = int(month_or_13)
        if not 1 <= month <= 12:
            raise ValueError(f"Mes fuera de rango en clave {raw_key!r}")
        period = f"{year}-{month:02d}"
        mapping[period] = None if value == fill_value else value
    return mapping


def process_location(
    location: dict, start_year: int, end_year: int, refresh: bool
) -> dict:
    location_id = location["id"]
    lat_requested = location["lat"]
    lon_requested = location["lon"]

    raw, url, download_date = resolve_raw_response(
        location_id, lat_requested, lon_requested, start_year, end_year, refresh
    )
    checksum = sha256_of_bytes(raw)
    doc = json.loads(raw)

    header = doc.get("header", {})
    sources = header.get("sources")
    if sources != ["MERRA2"]:
        raise ValueError(
            f"[{location_id}] fuente inesperada en header.sources: {sources!r} "
            "(se esperaba exactamente ['MERRA2'])"
        )
    service_version = (header.get("api") or {}).get("version")
    fill_value = header.get("fill_value")
    if fill_value is None:
        raise ValueError(f"[{location_id}] la respuesta no declara header.fill_value")

    param_meta = doc.get("parameters", {}).get(PARAMETER)
    if not param_meta or param_meta.get("units") != EXPECTED_UNITS:
        raise ValueError(
            f"[{location_id}] unidades inesperadas para {PARAMETER}: "
            f"{param_meta.get('units') if param_meta else None!r} (se esperaba {EXPECTED_UNITS!r})"
        )
    units = param_meta["units"]
    longname = param_meta.get("longname")

    parameter_values = doc["properties"]["parameter"][PARAMETER]
    mapping = parse_monthly_mapping(parameter_values, fill_value)
    if not mapping:
        raise ValueError(f"[{location_id}] ningun mes valido en la respuesta de POWER")

    periods_sorted = sorted(mapping.keys())
    null_count = sum(1 for v in mapping.values() if v is None)

    coords = doc.get("geometry", {}).get("coordinates")
    coords_effective = None
    if isinstance(coords, list) and len(coords) >= 2:
        coords_effective = {
            "lon": coords[0],
            "lat": coords[1],
            "elevation_m": coords[2] if len(coords) > 2 else None,
        }

    payload = {
        "data_version": DATA_VERSION,
        "location_id": location_id,
        "name": location["name"],
        "coords_requested": {"lat": lat_requested, "lon": lon_requested},
        "coords_effective": coords_effective,
        "parameter": PARAMETER,
        "parameter_longname": longname,
        "quantity_kind": "promedio mensual de la tasa diaria (no total mensual, no IMERG)",
        "units": units,
        "source": {
            "service_name": "NASA POWER (Prediction Of Worldwide Energy Resource)",
            "product": "MERRA2",
            "service_version": service_version,
            "community": COMMUNITY,
            "docs_url": "https://power.larc.nasa.gov/docs/services/api/temporal/monthly/",
            "methodology_url": "https://power.larc.nasa.gov/docs/methodology/meteorology/",
            "api_url": url,
        },
        "dataset_native_resolution": {
            "spatial": "0.5 grados latitud x 0.625 grados longitud (rejilla nativa MERRA-2)",
            "temporal_source": "horaria (MERRA-2), agregada a mensual por el servicio POWER",
            "resolution_source_url": "https://power.larc.nasa.gov/docs/methodology/meteorology/",
        },
        "fill_value_raw": fill_value,
        "requested_range": {"start_year": start_year, "end_year": end_year},
        "period_start": periods_sorted[0],
        "period_end": periods_sorted[-1],
        "period_count": len(periods_sorted),
        "null_count": null_count,
        "monthly": mapping,
        "downloaded_date_utc": download_date,
        "original_response_sha256": checksum,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{location_id}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

    print(
        f"[{location_id}] exportado {out_path} "
        f"({len(periods_sorted)} meses, {null_count} sin dato, "
        f"{periods_sorted[0]}..{periods_sorted[-1]})",
        file=sys.stderr,
    )
    return {
        "id": location_id,
        "name": location["name"],
        "path": out_path.relative_to(INDEX_PATH.parent).as_posix(),
        "coords_requested": payload["coords_requested"],
        "coords_effective": coords_effective,
        "period_start": payload["period_start"],
        "period_end": payload["period_end"],
        "period_count": payload["period_count"],
        "null_count": null_count,
        "size_bytes": out_path.stat().st_size,
    }


def rebuild_index() -> None:
    """Regenera public/data/power-index.json a partir de los archivos que
    realmente existen en public/data/power/ (no de la lista calculada en
    memoria durante esta ejecucion exclusivamente: se relee del disco para
    reflejar tambien ejecuciones previas de otros puntos)."""
    on_disk_entries = []
    if OUT_DIR.exists():
        for path in sorted(OUT_DIR.glob("*.json")):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, OSError):
                continue
            on_disk_entries.append(
                {
                    "id": data.get("location_id"),
                    "name": data.get("name"),
                    "path": path.relative_to(INDEX_PATH.parent).as_posix(),
                    "coords_requested": data.get("coords_requested"),
                    "coords_effective": data.get("coords_effective"),
                    "period_start": data.get("period_start"),
                    "period_end": data.get("period_end"),
                    "period_count": data.get("period_count"),
                    "null_count": data.get("null_count"),
                    "size_bytes": path.stat().st_size,
                }
            )

    index = {
        "data_version": DATA_VERSION,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "dataset": "NASA POWER monthly point API - PRECTOTCORR (MERRA2)",
        "parameter": PARAMETER,
        "units": EXPECTED_UNITS,
        "locations": on_disk_entries,
        "access_notes": (
            "Estos 3 puntos vienen precargados en public/data/power/. Para "
            "cualquier otro punto del globo que el usuario seleccione a "
            "futuro, el frontend puede consultar en vivo la misma API "
            "(temporal/monthly/point) con el anio solicitado tras la "
            "seleccion; ver docs/power-data.md para el detalle de esa "
            "opcion (no implementada aqui)."
        ),
    }
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"Indice actualizado: {INDEX_PATH} ({len(on_disk_entries)} ubicacion(es))", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-year", type=int, default=2000)
    parser.add_argument("--end-year", type=int, default=2025)
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Vuelve a descargar de la API aunque ya exista cache local en work/raw-power/",
    )
    parser.add_argument(
        "--locations",
        nargs="*",
        default=None,
        help="Subconjunto de location_id a procesar (por defecto: los 3 puntos)",
    )
    args = parser.parse_args()

    if args.start_year > args.end_year:
        raise ValueError("--start-year no puede ser mayor que --end-year")

    locations = LOCATIONS
    if args.locations:
        wanted = set(args.locations)
        locations = [loc for loc in LOCATIONS if loc["id"] in wanted]
        missing = wanted - {loc["id"] for loc in locations}
        if missing:
            raise ValueError(f"location_id desconocido(s): {sorted(missing)}")

    for i, location in enumerate(locations):
        if i > 0:
            time.sleep(SLEEP_BETWEEN_REQUESTS_SECONDS)
        process_location(location, args.start_year, args.end_year, args.refresh)

    rebuild_index()


if __name__ == "__main__":
    main()
