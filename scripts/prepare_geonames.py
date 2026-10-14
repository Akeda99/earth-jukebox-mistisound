#!/usr/bin/env python3
"""Convierte GeoNames cities15000 en un JSON compacto para la ruta
'Tu historia con la Tierra' (busqueda de ciudad local, sin proveedor externo).

Fuente: https://download.geonames.org/export/dump/cities15000.zip
Licencia: Creative Commons Attribution 4.0 (https://www.geonames.org/export/).
Se descarga una vez a work/raw-geonames/ (o se usa --input) y se registra su SHA-256.
Cada fila: [id, nombre, pais, lat, lon, poblacion, claves]; 'claves' son el nombre,
asciiname y hasta 3 alternativos latinos, sin acentos y en minuscula, unidos por '|'.
"""
from __future__ import annotations
import argparse, hashlib, json, re, sys, unicodedata, urllib.request, zipfile
from datetime import datetime, timezone
from pathlib import Path

URL = "https://download.geonames.org/export/dump/cities15000.zip"
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "work" / "raw-geonames" / "cities15000.zip"
OUT = ROOT / "public" / "data" / "geonames-cities.json"
LATIN = re.compile(r"^[a-z0-9 .'\-]+$")


def fold(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.lower().strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=None)
    args = ap.parse_args()
    src = Path(args.input) if args.input else RAW
    if not src.exists():
        src.parent.mkdir(parents=True, exist_ok=True)
        print(f"Descargando {URL}", file=sys.stderr)
        urllib.request.urlretrieve(URL, src)
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    with zipfile.ZipFile(src) as z:
        text = z.read("cities15000.txt").decode("utf-8")
    rows = []
    for line in text.splitlines():
        f = line.split("\t")
        if len(f) < 15:
            continue
        gid, name, ascii_name, alts, lat, lon, cc, pop = f[0], f[1], f[2], f[3], f[4], f[5], f[8], f[14]
        keys = []
        for cand in [name, ascii_name] + alts.split(","):
            k = fold(cand)
            if k and LATIN.match(k) and k not in keys and len(k) <= 40:
                keys.append(k)
            if len(keys) >= 5:
                break
        rows.append([int(gid), name, cc, round(float(lat), 3), round(float(lon), 3), int(pop or 0), "|".join(keys)])
    rows.sort(key=lambda r: -r[5])
    payload = {
        "source": "GeoNames cities15000",
        "source_url": URL,
        "license": "CC BY 4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": "GeoNames (geonames.org)",
        "original_zip_sha256": sha,
        "prepared_utc": datetime.now(timezone.utc).isoformat(),
        "fields": ["id", "name", "country", "lat", "lon", "population", "keys"],
        "count": len(rows),
        "rows": rows,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} ciudades -> {OUT} ({OUT.stat().st_size} bytes), sha {sha}", file=sys.stderr)


if __name__ == "__main__":
    main()
