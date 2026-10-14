"""Pruebas con un CSV FIXTURE SINTETICO (no datos reales de FIRMS) que
verifican los filtros de confianza, tipo, bbox y mes, y el conteo por
celda de 2 grados."""

import csv

import numpy as np

from prepare_fires import count_detections, build_grid_axes, BBOX, CONFIDENCE_MIN


FIELDS = [
    "latitude", "longitude", "brightness", "scan", "track", "acq_date",
    "acq_time", "satellite", "instrument", "confidence", "version",
    "bright_t31", "frp", "daynight", "type",
]


def _write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _row(lat, lon, acq_date, confidence, type_="0"):
    return {
        "latitude": lat, "longitude": lon, "brightness": 320.0, "scan": 1.0,
        "track": 1.0, "acq_date": acq_date, "acq_time": "1200",
        "satellite": "Terra", "instrument": "MODIS", "confidence": confidence,
        "version": "6.1", "bright_t31": 290.0, "frp": 15.0, "daynight": "D",
        "type": type_,
    }


def test_counts_only_vegetation_fires_above_confidence_inside_bbox_and_month(tmp_path):
    # Celda esperada: centro cerca de lat=-5, lon=-70 (dentro del bbox Peru+Amazonia)
    rows = [
        _row(-5.3, -70.2, "2023-01-15", confidence=80, type_="0"),  # cuenta
        _row(-5.1, -70.4, "2023-01-20", confidence=80, type_="0"),  # cuenta (misma celda)
        _row(-5.3, -70.2, "2023-01-15", confidence=10, type_="0"),  # descartada: confianza baja
        _row(-5.3, -70.2, "2023-01-15", confidence=80, type_="1"),  # descartada: volcan
        _row(-5.3, -70.2, "2023-02-15", confidence=80, type_="0"),  # descartada: mes distinto
        _row(10.0, 10.0, "2023-01-15", confidence=80, type_="0"),   # descartada: fuera de bbox (Africa)
    ]
    csv_path = tmp_path / "firms_fixture.csv"
    _write_csv(csv_path, rows)

    counts, total_rows, kept_rows = count_detections(csv_path, 2023, 1)

    assert total_rows == len(rows)
    assert kept_rows == 2

    lat_centers, lon_centers = build_grid_axes()
    lat_i = int(np.argmin(np.abs(lat_centers - (-5.2))))
    lon_i = int(np.argmin(np.abs(lon_centers - (-70.3))))
    assert counts[lat_i, lon_i] == 2


def test_cells_outside_bbox_are_null_inside_bbox_are_zero_or_more(tmp_path):
    rows = [_row(-5.3, -70.2, "2023-01-15", confidence=80, type_="0")]
    csv_path = tmp_path / "firms_fixture.csv"
    _write_csv(csv_path, rows)

    counts, _, _ = count_detections(csv_path, 2023, 1)
    lat_centers, lon_centers = build_grid_axes()

    lon_w, lat_s, lon_e, lat_n = BBOX
    for lat_i, lat_c in enumerate(lat_centers):
        for lon_i, lon_c in enumerate(lon_centers):
            inside = lon_w <= lon_c <= lon_e and lat_s <= lat_c <= lat_n
            if inside:
                assert counts[lat_i, lon_i] >= 0
            else:
                assert counts[lat_i, lon_i] == -1  # -1 = codificacion interna de "fuera de bbox" (se exporta como null)


def test_missing_type_column_raises_clear_error(tmp_path):
    csv_path = tmp_path / "nrt_fixture.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["latitude", "longitude", "acq_date", "confidence"])
        writer.writeheader()
        writer.writerow({"latitude": -5.3, "longitude": -70.2, "acq_date": "2023-01-15", "confidence": 80})

    try:
        count_detections(csv_path, 2023, 1)
        assert False, "se esperaba ValueError por falta de columna 'type'"
    except ValueError as exc:
        assert "type" in str(exc)
