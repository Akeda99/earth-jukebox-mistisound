"""Pruebas Python de los preparadores de precipitacion/incendios/hielo
marino. Todos los datos usados aqui son FIXTURES SINTETICOS construidos en
el propio test (no datos reales de NASA): sirven solo para verificar la
logica de escala, unidades, null y reproyeccion. Ningun archivo generado
por estas pruebas se escribe en public/data/.
"""

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
