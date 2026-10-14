"""Pruebas de prepare_sea_ice_g02135.py (NOAA/NSIDC G02135 v4.0, GeoTIFF).

Dos grupos:
1. Fixture SINTETICO (GeoTIFF de juguete con GeoKeys/ModelPixelScale/
   ModelTiepoint reales pero datos inventados): verifica decodificacion de
   flags (2510/2530/2540/2550), escalado 0..1000 -> 0..1 y lectura de CRS
   real desde los tags del archivo (no asumido por hemisferio).
2. Comparacion INDEPENDIENTE contra los GeoTIFF originales reales de enero
   2023. Dos ubicaciones posibles, probadas en orden (nunca se inventa
   nada si ninguna existe: las pruebas se omiten):
   a. `work/raw-pending/sea-ice/` en la carpeta PADRE del proyecto (donde
      quedaron los originales investigados originalmente, fuera del
      alcance de un ZIP de entrega).
   b. `work/raw-dj/sea-ice-g02135/{north,south}_202301.tif` DENTRO del
      proyecto (la cache propia que `prepare_sea_ice_g02135.py` crea al
      ejecutarse, ver resolve_hemisphere_file): si alguien recibe el
      proyecto en un ZIP fresco sin la carpeta padre, corriendo primero
      `py -3 scripts/prepare_sea_ice_g02135.py --year 2023 --month 1` (o
      `--all-2023`) esta ruta queda poblada y estas 5 pruebas se pueden
      repetir igual, sin ninguna ruta de maquina especifica hardcodeada.
   La verificacion recalcula la reproyeccion y el promedio por celda con
   un Transformer y bucles propios, SIN llamar a accumulate_hemisphere,
   para no limitarse a comprobar que el script se repite a si mismo.
"""

from pathlib import Path

import numpy as np
import pytest
import tifffile
from pyproj import Transformer

from prepare_sea_ice_g02135 import (
    read_geotiff_grid,
    accumulate_hemisphere,
    build_grid_axes,
    FLAG_POLE_HOLE,
    FLAG_COAST,
    FLAG_LAND,
    FLAG_MISSING,
    MAX_VALID_RAW,
    GRID_RESOLUTION_DEG,
)


def _resolve_real_file(parent_name: str, project_cache_name: str) -> Path:
    """Primero busca en work/raw-pending/sea-ice/ (carpeta padre, fuera del
    ZIP); si no existe, cae a la cache propia del proyecto
    work/raw-dj/sea-ice-g02135/ (poblada por una corrida real de
    prepare_sea_ice_g02135.py). Ninguna ruta aqui es especifica de una
    maquina: ambas son relativas a este archivo de test."""
    project_root = Path(__file__).resolve().parents[2]  # .../outputs/earth-jukebox
    parent_candidate = project_root.parent.parent / "work" / "raw-pending" / "sea-ice" / parent_name
    if parent_candidate.exists():
        return parent_candidate
    return project_root / "work" / "raw-dj" / "sea-ice-g02135" / project_cache_name


REAL_NORTH = _resolve_real_file("N_202301_concentration_v4.0.tif", "north_202301.tif")
REAL_SOUTH = _resolve_real_file("S_202301_concentration_v4.0.tif", "south_202301.tif")

pytestmark_real = pytest.mark.skipif(
    not (REAL_NORTH.exists() and REAL_SOUTH.exists()),
    reason=(
        "GeoTIFF reales de enero 2023 no disponibles: ni en work/raw-pending/sea-ice/ "
        "(carpeta padre) ni en work/raw-dj/sea-ice-g02135/ (cache del proyecto; "
        "ejecutar antes 'py -3 scripts/prepare_sea_ice_g02135.py --year 2023 --month 1' "
        "para poblarla)"
    ),
)


def _write_synthetic_geotiff(path: Path, raw: np.ndarray, epsg: int, origin_xy: tuple[float, float], scale_m: float):
    """Escribe un GeoTIFF de 1 banda con GeoKeys/ModelPixelScale/
    ModelTiepoint REALES (leibles por tifffile como los originales), con
    datos sinteticos conocidos."""
    geokeys = (
        1, 1, 0, 4,
        1024, 0, 1, 1,   # GTModelTypeGeoKey = ModelTypeProjected
        1025, 0, 1, 1,   # GTRasterTypeGeoKey = RasterPixelIsArea
        3072, 0, 1, epsg,  # ProjectedCSTypeGeoKey
        3076, 0, 1, 9001,  # ProjLinearUnitsGeoKey = metre
    )
    extratags = [
        (33550, "d", 3, (scale_m, scale_m, 0.0), True),
        (33922, "d", 6, (0.0, 0.0, 0.0, origin_xy[0], origin_xy[1], 0.0), True),
        (34735, "H", len(geokeys), geokeys, True),
    ]
    tifffile.imwrite(str(path), raw.astype(np.uint16), photometric="minisblack", extratags=extratags)


def test_synthetic_flags_excluded_not_zero(tmp_path):
    raw = np.array(
        [
            [500.0, FLAG_LAND, 500.0, 500.0],
            [FLAG_POLE_HOLE, 500.0, 500.0, 500.0],
            [500.0, 500.0, FLAG_COAST, 500.0],
            [500.0, 500.0, 500.0, 0.0],
        ]
    )
    path = tmp_path / "synthetic_north.tif"
    _write_synthetic_geotiff(path, raw, epsg=3411, origin_xy=(-50000.0, 50000.0), scale_m=25000.0)

    lon_2d, lat_2d, fraction_2d, epsg = read_geotiff_grid(path)

    assert epsg == 3411  # leido del archivo, no asumido
    assert np.isnan(fraction_2d[0, 1])  # tierra excluida, no 0.0
    assert np.isnan(fraction_2d[1, 0])  # pole hole excluida
    assert np.isnan(fraction_2d[2, 2])  # costa excluida
    assert not np.isnan(fraction_2d[3, 3])
    assert np.isclose(fraction_2d[3, 3], 0.0)  # agua abierta real = 0% hielo


def test_synthetic_missing_flag_excluded(tmp_path):
    raw = np.array([[FLAG_MISSING, 1000.0], [250.0, 750.0]])
    path = tmp_path / "synthetic_south.tif"
    _write_synthetic_geotiff(path, raw, epsg=3412, origin_xy=(-25000.0, 25000.0), scale_m=25000.0)

    _, _, fraction_2d, epsg = read_geotiff_grid(path)
    assert epsg == 3412
    assert np.isnan(fraction_2d[0, 0])  # 2550 sin dato, excluido
    assert np.isclose(fraction_2d[0, 1], 1.0)  # 1000 -> 100% hielo
    assert np.isclose(fraction_2d[1, 0], 0.25)
    assert np.isclose(fraction_2d[1, 1], 0.75)


def test_raw_above_max_valid_but_not_a_known_flag_is_still_excluded(tmp_path):
    raw = np.array([[1000.0, 1001.0], [2000.0, 500.0]])
    path = tmp_path / "synthetic_edge.tif"
    _write_synthetic_geotiff(path, raw, epsg=3411, origin_xy=(0.0, 0.0), scale_m=25000.0)

    _, _, fraction_2d, _ = read_geotiff_grid(path)
    assert np.isclose(fraction_2d[0, 0], 1.0)
    assert np.isnan(fraction_2d[0, 1])  # > MAX_VALID_RAW y no es un flag de la tabla 5, pero se excluye igual
    assert np.isnan(fraction_2d[1, 0])


def test_reprojection_places_pixels_near_pole_at_high_latitude(tmp_path):
    raw = np.full((4, 4), 500.0)
    path = tmp_path / "synthetic_pole.tif"
    _write_synthetic_geotiff(path, raw, epsg=3411, origin_xy=(-50000.0, 50000.0), scale_m=25000.0)

    lon_2d, lat_2d, fraction_2d, _ = read_geotiff_grid(path)
    assert np.all(lat_2d > 80.0)

    lat_centers, lon_centers = build_grid_axes()
    sum_grid = np.zeros((len(lat_centers), len(lon_centers)))
    weight_grid = np.zeros((len(lat_centers), len(lon_centers)))
    accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)
    pole_lat_i = int(np.argmin(np.abs(lat_centers - 89.0)))
    assert weight_grid[pole_lat_i, :].sum() > 0


# --- Comparacion independiente contra GeoTIFF reales (5 celdas) ---------

def _cell_index(lat, lon, lat_centers, lon_centers):
    n_lon = len(lon_centers)
    lat_i = int(np.clip(int((lat - (-90)) // GRID_RESOLUTION_DEG), 0, len(lat_centers) - 1))
    lon_i = int(np.clip(int((lon - (-180)) // GRID_RESOLUTION_DEG), 0, len(lon_centers) - 1))
    return lat_i, lon_i, lat_i * n_lon + lon_i


def _independent_cell_average(tif_path: Path, target_lat_i: int, target_lon_i: int, lat_centers, lon_centers):
    """Segunda implementacion, deliberadamente NO vectorizada y con su
    propio Transformer, que recorre pixel por pixel y promedia solo los
    que caen en la celda destino pedida. No reutiliza accumulate_hemisphere
    ni read_geotiff_grid para el promedio (si para leer los tags, que es
    metadata real del archivo, no un calculo a verificar)."""
    with tifffile.TiffFile(str(tif_path)) as tif:
        page = tif.pages[0]
        raw = page.asarray()
        scale_x, scale_y, _ = page.tags[33550].value
        tiepoint = page.tags[33922].value
        origin_x, origin_y = tiepoint[3], tiepoint[4]
        geokeys = page.tags[34735].value
        num_keys = geokeys[3]
        epsg = None
        for i in range(num_keys):
            base = 4 + i * 4
            key_id, _, count, value = geokeys[base : base + 4]
            if key_id == 3072 and count == 1:
                epsg = value
        assert epsg is not None

    transformer = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)

    n_rows, n_cols = raw.shape
    total = 0.0
    count = 0
    for row in range(n_rows):
        y = origin_y - (row + 0.5) * scale_y
        for col in range(n_cols):
            value = float(raw[row, col])
            if value > MAX_VALID_RAW:
                continue
            x = origin_x + (col + 0.5) * scale_x
            lon, lat = transformer.transform(x, y)
            lat_i = int(np.clip(int((lat - (-90)) // GRID_RESOLUTION_DEG), 0, len(lat_centers) - 1))
            lon_i = int(np.clip(int((lon - (-180)) // GRID_RESOLUTION_DEG), 0, len(lon_centers) - 1))
            if lat_i == target_lat_i and lon_i == target_lon_i:
                total += value / MAX_VALID_RAW
                count += 1
    return (total / count if count else None), count


@pytestmark_real
def test_real_north_arctic_ice_interior_cell_matches_independent_recomputation():
    lat_centers, lon_centers = build_grid_axes()
    lon_2d, lat_2d, fraction_2d, epsg = read_geotiff_grid(REAL_NORTH)
    assert epsg == 3411

    # Pixel conocido de hielo solido (raw=1000) lejos de costa/pole-hole.
    r, c = 71, 134
    lat_i, lon_i, _ = _cell_index(lat_2d[r, c], lon_2d[r, c], lat_centers, lon_centers)

    sum_grid = np.zeros((len(lat_centers), len(lon_centers)))
    weight_grid = np.zeros((len(lat_centers), len(lon_centers)))
    accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)
    production_value = sum_grid[lat_i, lon_i] / weight_grid[lat_i, lon_i]
    production_count = int(weight_grid[lat_i, lon_i])

    independent_value, independent_count = _independent_cell_average(REAL_NORTH, lat_i, lon_i, lat_centers, lon_centers)

    assert independent_count == production_count
    assert independent_value is not None
    assert production_value > 0.9  # celda de hielo solido real
    assert np.isclose(independent_value, production_value, atol=1e-9)


@pytestmark_real
def test_real_north_open_ocean_cell_matches_independent_recomputation():
    lat_centers, lon_centers = build_grid_axes()
    lon_2d, lat_2d, fraction_2d, _ = read_geotiff_grid(REAL_NORTH)

    r, c = 0, 0  # pixel oceanico real con raw=0 (agua abierta, no tierra)
    lat_i, lon_i, _ = _cell_index(lat_2d[r, c], lon_2d[r, c], lat_centers, lon_centers)

    sum_grid = np.zeros((len(lat_centers), len(lon_centers)))
    weight_grid = np.zeros((len(lat_centers), len(lon_centers)))
    accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)
    production_value = sum_grid[lat_i, lon_i] / weight_grid[lat_i, lon_i]
    production_count = int(weight_grid[lat_i, lon_i])

    independent_value, independent_count = _independent_cell_average(REAL_NORTH, lat_i, lon_i, lat_centers, lon_centers)

    assert independent_count == production_count
    assert independent_value is not None
    assert production_value < 0.05  # celda oceanica abierta real, bajo el umbral 15%
    assert np.isclose(independent_value, production_value, atol=1e-9)


@pytestmark_real
def test_real_south_antarctic_ice_interior_cell_matches_independent_recomputation():
    lat_centers, lon_centers = build_grid_axes()
    lon_2d, lat_2d, fraction_2d, epsg = read_geotiff_grid(REAL_SOUTH)
    assert epsg == 3412

    r, c = 99, 214  # pixel de hielo solido real (raw=1000)
    lat_i, lon_i, _ = _cell_index(lat_2d[r, c], lon_2d[r, c], lat_centers, lon_centers)

    sum_grid = np.zeros((len(lat_centers), len(lon_centers)))
    weight_grid = np.zeros((len(lat_centers), len(lon_centers)))
    accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)
    production_value = sum_grid[lat_i, lon_i] / weight_grid[lat_i, lon_i]
    production_count = int(weight_grid[lat_i, lon_i])

    independent_value, independent_count = _independent_cell_average(REAL_SOUTH, lat_i, lon_i, lat_centers, lon_centers)

    assert independent_count == production_count
    assert independent_value is not None
    assert production_value > 0.9
    assert np.isclose(independent_value, production_value, atol=1e-9)


@pytestmark_real
def test_real_north_land_locked_cell_has_no_valid_ocean_pixel_and_is_null():
    """Celda deep-inland (interior de Asia continental) donde TODO pixel
    fuente real es tierra (2540): la celda de 2 grados debe quedar sin
    ningun pixel valido (cobertura 0), nunca en 0.0."""
    lat_centers, lon_centers = build_grid_axes()
    lon_2d, lat_2d, fraction_2d, _ = read_geotiff_grid(REAL_NORTH)

    r, c = 25, 207  # pixel real con flag 2540 (tierra)
    lat_i, lon_i, _ = _cell_index(lat_2d[r, c], lon_2d[r, c], lat_centers, lon_centers)

    sum_grid = np.zeros((len(lat_centers), len(lon_centers)))
    weight_grid = np.zeros((len(lat_centers), len(lon_centers)))
    accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)

    assert weight_grid[lat_i, lon_i] == 0  # ningun pixel oceanico valido

    independent_value, independent_count = _independent_cell_average(REAL_NORTH, lat_i, lon_i, lat_centers, lon_centers)
    assert independent_count == 0
    assert independent_value is None


@pytestmark_real
def test_real_north_pole_hole_cell_excluded_from_average_not_zero():
    """La celda que contiene el pixel real de pole-hole (2510) no debe
    tener ningun pixel valido que lo reemplace por 0: en este caso real la
    celda completa queda sin cobertura oceanica valida."""
    lat_centers, lon_centers = build_grid_axes()
    lon_2d, lat_2d, fraction_2d, _ = read_geotiff_grid(REAL_NORTH)

    r, c = 230, 153  # pixel real con flag 2510 (pole hole)
    lat_i, lon_i, _ = _cell_index(lat_2d[r, c], lon_2d[r, c], lat_centers, lon_centers)

    sum_grid = np.zeros((len(lat_centers), len(lon_centers)))
    weight_grid = np.zeros((len(lat_centers), len(lon_centers)))
    accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)

    assert weight_grid[lat_i, lon_i] == 0

    independent_value, independent_count = _independent_cell_average(REAL_NORTH, lat_i, lon_i, lat_centers, lon_centers)
    assert independent_count == 0
    assert independent_value is None
