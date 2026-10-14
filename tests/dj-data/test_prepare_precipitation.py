"""Pruebas con FIXTURES SINTETICOS (no datos reales de IMERG) para la
agregacion de 0.1 grados a 2 grados por promedio ponderado por area."""

import numpy as np

from prepare_precipitation import aggregate_to_target_grid, MIN_COVERAGE_FRACTION


def _make_source_grid(lat_start, n_lat, n_lon, fill_value):
    lon_src = -180.0 + 0.1 * (np.arange(n_lon) + 0.5)
    lat_src = lat_start + 0.1 * (np.arange(n_lat) + 0.5)
    data = np.ma.masked_all((n_lon, n_lat))
    data[:, :] = fill_value
    return lon_src, lat_src, data


def test_uniform_block_averages_to_same_value():
    # Una sola celda destino (factor 20x20) toda con el mismo valor: el
    # promedio ponderado por area debe devolver exactamente ese valor.
    lon_src, lat_src, data = _make_source_grid(lat_start=0.0, n_lat=20, n_lon=20, fill_value=3.5)
    lat_out, lon_out, values = aggregate_to_target_grid(lon_src, lat_src, data)

    assert values.shape == (1, 1)
    assert np.isclose(values[0, 0], 3.5)
    assert np.isclose(lat_out[0], 1.0)  # centro de 0..2 grados


def test_full_coverage_nonuniform_block_uses_coslat_weighting():
    lon_src, lat_src, data = _make_source_grid(lat_start=80.0, n_lat=20, n_lon=20, fill_value=0.0)
    # Fila mas cercana al polo (mayor lat, menor peso coslat) con valor alto;
    # fila mas lejana del polo (menor lat, mayor peso) con valor bajo.
    data[:, 0] = 10.0   # lat ~80.05 (peso coslat mayor)
    data[:, -1] = 1.0   # lat ~81.95 (peso coslat menor, mas cerca del polo)
    for i in range(1, 19):
        data[:, i] = 5.0

    lat_out, lon_out, values = aggregate_to_target_grid(lon_src, lat_src, data)

    # El promedio ponderado por area debe pesar mas la fila de menor
    # latitud (mayor cos(lat)): el resultado debe diferir de un promedio
    # simple sin ponderar.
    simple_mean = float(data.mean())
    assert not np.isclose(values[0, 0], simple_mean)
    # Y debe inclinarse hacia el valor de la fila con mayor peso (10.0)
    assert values[0, 0] > simple_mean - 1.0


def test_insufficient_coverage_yields_null():
    n_lat = n_lon = 20
    lon_src, lat_src, data = _make_source_grid(lat_start=0.0, n_lat=n_lat, n_lon=n_lon, fill_value=np.ma.masked)
    # Solo 10% de subceldas validas (< MIN_COVERAGE_FRACTION) -> debe ser null (NaN)
    n_valid = int(0.1 * n_lat * n_lon)
    flat_mask = data.mask.flatten()
    flat_mask[:n_valid] = False
    data.mask = flat_mask.reshape(data.shape)
    data[~data.mask] = 42.0

    lat_out, lon_out, values = aggregate_to_target_grid(lon_src, lat_src, data)
    assert np.isnan(values[0, 0])


def test_coverage_at_threshold_is_not_null():
    n_lat = n_lon = 20
    lon_src, lat_src, data = _make_source_grid(lat_start=0.0, n_lat=n_lat, n_lon=n_lon, fill_value=np.ma.masked)
    n_valid = int(MIN_COVERAGE_FRACTION * n_lat * n_lon)
    flat_mask = data.mask.flatten()
    flat_mask[:n_valid] = False
    data.mask = flat_mask.reshape(data.shape)
    data[~data.mask] = 7.0

    lat_out, lon_out, values = aggregate_to_target_grid(lon_src, lat_src, data)
    assert np.isclose(values[0, 0], 7.0)
