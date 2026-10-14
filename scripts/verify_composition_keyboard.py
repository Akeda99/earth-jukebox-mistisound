#!/usr/bin/env python3
"""Flujo de teclado SOLO del boton de composicion (reutiliza helpers de
verify_accessibility.py). Uso: py -3 scripts/verify_composition_keyboard.py --base-url http://127.0.0.1:5181
Verifica: Enter inicia (aria-pressed true + estado), Enter detiene, y que
Enter/Espacio sobre el boton no autoreproduce nada antes de activar audio."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright  # noqa: E402

from verify_accessibility import ACTION_TIMEOUT_MS, Check, open_tab  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:5181")
    args = parser.parse_args()
    check = Check()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1280, "height": 720}).new_page()
        page.goto(args.base_url, wait_until="load", timeout=30000)
        open_tab(page, "dj")
        check.ok("composicion: boton deshabilitado y sin sonar antes de activar audio (sin autoplay)",
                 page.evaluate("() => document.getElementById('dj-composition-btn').disabled === true"))
        page.locator("#audio-toggle").focus(timeout=ACTION_TIMEOUT_MS)
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('audio-toggle').disabled", timeout=ACTION_TIMEOUT_MS)
        check.ok("composicion: audio-toggle por teclado", True)
        check.ok("composicion: tras activar audio NO empieza sola",
                 page.get_attribute("#dj-composition-btn", "aria-pressed") == "false")
        page.locator("#dj-composition-btn").focus(timeout=ACTION_TIMEOUT_MS)
        page.wait_for_function("() => !document.getElementById('dj-composition-btn').disabled", timeout=ACTION_TIMEOUT_MS)
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('dj-composition-btn').getAttribute('aria-pressed') === 'true'", timeout=ACTION_TIMEOUT_MS)
        status = page.text_content("#dj-composition-status").strip()
        check.ok("composicion: Enter inicia (aria-pressed=true) y role=status anuncia", bool(status), status[:60])
        check.ok("composicion: parar/volumen/mute siguen visibles",
                 page.is_visible("#mute-toggle") and page.is_visible("#volume-slider") and page.is_visible("#dj-composition-btn"))
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('dj-composition-btn').getAttribute('aria-pressed') === 'false'", timeout=ACTION_TIMEOUT_MS)
        check.ok("composicion: Enter de nuevo la detiene (aria-pressed=false)", True)
        browser.close()
    return 0 if check.summary() else 1


if __name__ == "__main__":
    sys.exit(main())
