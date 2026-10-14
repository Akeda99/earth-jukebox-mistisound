"""Pruebas con un NetCDF FIXTURE SINTETICO (no datos reales de NSIDC-0051)
que verifica la decodificacion de flags (tierra/costa/pole-hole/sin-dato),
el escalado 0..250 -> 0..1, y la reproyeccion EPSG:3411 -> lon/lat seguida
de la agregacion a la rejilla de 2 grados."""

from pathlib import Path

import netCDF4 as nc
import numpy as np
import pytest
from pyproj import Transformer

from prepare_sea_ice import (
    load_hemisphere_grid,
    accumulate_hemisphere,
    build_grid_axes,
    FLAG_LAND,
    FLAG_POLE_HOLE,
    FLAG_COAST,
)


def _make_synthetic_north_file(path: Path):
    """4x4 pixeles de 25km alrededor del origen de EPSG:3411, con una
    mezcla deliberada de flags y un valor valido conocido."""
    ds = nc.Dataset(path, "w", format="NETCDF4")
    try:
        ds.createDimension("t", 1)
        ds.createDimension("y", 4)
        ds.createDimension("x", 4)

        x = ds.createVariable("x", "f8", ("x",))
        y = ds.createVariable("y", "f8", ("y",))
        # Centros de celda de 25 km, cerca del polo norte (origen EPSG:3411)
        x[:] = np.array([-37.5, -12.5, 12.5, 37.5]) * 1000.0
        y[:] = np.array([37.5, 12.5, -12.5, -37.5]) * 1000.0

        var = ds.createVariable("F17_ICECON", "f8", ("t", "y", "x"))
        raw = np.array([
            [125.0, 254.0, 125.0, 125.0],   # fila 0: un pixel de tierra (254)
            [251.0, 125.0, 125.0, 125.0],   # fila 1: un pole hole (251)
            [125.0, 125.0, 253.0, 125.0],   # fila 2: una costa (253)
            [125.0, 125.0, 125.0, 0.0],     # fila 3: agua abierta (0% hielo)
        ])
        var[0, :, :] = raw
    finally:
        ds.close()


def test_flags_are_excluded_not_zero(tmp_path):
    nc_path = tmp_path / "synthetic_north.nc"
    _make_synthetic_north_file(nc_path)

    lon_2d, lat_2d, fraction_2d = load_hemisphere_grid(nc_path, "north", 2023, 1)

    assert np.isnan(fraction_2d[0, 1])  # tierra (254) excluida, no 0.0
    assert np.isnan(fraction_2d[1, 0])  # pole hole (251) excluida
    assert np.isnan(fraction_2d[2, 2])  # costa (253) excluida
    assert not np.isnan(fraction_2d[3, 3])
    assert np.isclose(fraction_2d[3, 3], 0.0)  # agua abierta real = 0% hielo (si es valido, 0.0 es correcto)


def test_valid_raw_value_scales_to_fraction(tmp_path):
    nc_path = tmp_path / "synthetic_north.nc"
    _make_synthetic_north_file(nc_path)

    _, _, fraction_2d = load_hemisphere_grid(nc_path, "north", 2023, 1)
    # raw=125 -> 125/250 = 0.5 (50% concentracion)
    assert np.isclose(fraction_2d[0, 0], 0.5)


def test_reprojection_and_aggregation_places_pixel_in_plausible_cell(tmp_path):
    nc_path = tmp_path / "synthetic_north.nc"
    _make_synthetic_north_file(nc_path)

    lon_2d, lat_2d, fraction_2d = load_hemisphere_grid(nc_path, "north", 2023, 1)

    # Todos los pixeles estan a pocos km del polo norte: deben reproyectar a
    # latitudes muy altas (>80N), confirmando que la transformacion EPSG:3411
    # -> EPSG:4326 se aplico (y no se dejaron las coordenadas en metros).
    assert np.all(lat_2d > 80.0)

    lat_centers, lon_centers = build_grid_axes()
    sum_grid = np.zeros((len(lat_centers), len(lon_centers)))
    weight_grid = np.zeros((len(lat_centers), len(lon_centers)))
    accumulate_hemisphere(lon_2d, lat_2d, fraction_2d, sum_grid, weight_grid, lat_centers, lon_centers)

    # La celda destino que cubre el polo (lat_center mas cercano a 89) debe
    # haber acumulado al menos un pixel valido.
    pole_lat_i = int(np.argmin(np.abs(lat_centers - 89.0)))
    assert weight_grid[pole_lat_i, :].sum() > 0


def test_missing_variable_for_requested_date_raises_clear_error(tmp_path):
    nc_path = tmp_path / "wrong_sensor.nc"
    ds = nc.Dataset(nc_path, "w", format="NETCDF4")
    try:
        ds.createDimension("t", 1)
        ds.createDimension("y", 2)
        ds.createDimension("x", 2)
        x = ds.createVariable("x", "f8", ("x",))
        y = ds.createVariable("y", "f8", ("y",))
        x[:] = [-12500.0, 12500.0]
        y[:] = [12500.0, -12500.0]
        ds.createVariable("F13_ICECON", "f8", ("t", "y", "x"))[0, :, :] = np.full((2, 2), 125.0)
    finally:
        ds.close()

    with pytest.raises(ValueError, match="F17_ICECON"):
        load_hemisphere_grid(nc_path, "north", 2023, 1)
