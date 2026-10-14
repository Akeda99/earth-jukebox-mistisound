"""Utilidad compartida por los preparadores de precipitacion/incendios/hielo
marino para mantener public/data/dj-index.json: un indice PROPIO de estos
tres datasets, separado del public/data/manifest.json compartido con otros
agentes (que este conjunto de scripts no debe tocar).

Cada preparador actualiza unicamente su propia seccion (clave de nivel
superior) y conserva las demas secciones tal cual las encuentre, para poder
ejecutarse de forma independiente sin pisar el trabajo de los otros
preparadores de este mismo grupo.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def update_index_section(index_path: Path, section: str, files: list[dict]) -> None:
    data: dict = {}
    if index_path.exists():
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)

    data[section] = {
        "files": files,
        "periods": sorted({Path(f["path"]).stem for f in files}),
    }
    data["generated_utc"] = datetime.now(timezone.utc).isoformat()

    index_path.parent.mkdir(parents=True, exist_ok=True)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
