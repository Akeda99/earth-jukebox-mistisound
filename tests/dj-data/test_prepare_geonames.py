"""Pruebas del catalogo GeoNames: fixture sintetico + chequeo del catalogo real."""
import json
import zipfile
from pathlib import Path

import prepare_geonames as pg

ROOT = Path(__file__).resolve().parent.parent.parent


def _row(gid, name, ascii_name, alts, lat, lon, cc, pop):
    f = [""] * 19
    f[0], f[1], f[2], f[3], f[4], f[5], f[8], f[14] = str(gid), name, ascii_name, alts, lat, lon, cc, str(pop)
    return "\t".join(f)


def test_fold_quita_acentos_y_pasa_a_minuscula():
    assert pg.fold("  Múnich ") == "munich"
    assert pg.fold("Ñuñoa") == "nunoa"


def test_prepara_catalogo_sintetico(tmp_path, monkeypatch):
    txt = "\n".join(
        [
            _row(1, "Lima", "Lima", "Ciudad de los Reyes,利马", "-12.04318", "-77.02824", "PE", 9751717),
            _row(2, "Lima", "Lima", "", "40.74255", "-84.10523", "US", 38000),
            _row(3, "Iquitos", "Iquitos", "", "-3.74912", "-73.25383", "PE", 437620),
        ]
    )
    zpath = tmp_path / "c.zip"
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr("cities15000.txt", txt)
    out = tmp_path / "out.json"
    monkeypatch.setattr(pg, "OUT", out)
    monkeypatch.setattr("sys.argv", ["x", "--input", str(zpath)])
    pg.main()
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["count"] == 3 and data["license"] == "CC BY 4.0"
    assert len(data["original_zip_sha256"]) == 64
    assert [r[0] for r in data["rows"]] == [1, 3, 2]  # poblacion descendente
    assert "ciudad de los reyes" in data["rows"][0][6]
    assert "利" not in data["rows"][0][6]  # solo claves latinas
    assert data["rows"][0][3] == -12.043  # redondeo a 3 decimales


def test_catalogo_real_si_existe():
    path = ROOT / "public" / "data" / "geonames-cities.json"
    if not path.exists():
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["count"] == len(data["rows"]) > 30000
    names = {(r[1], r[2]) for r in data["rows"]}
    assert ("Iquitos", "PE") in names
    assert all(-90 <= r[3] <= 90 and -180 <= r[4] <= 180 for r in data["rows"])
