#!/usr/bin/env python3
"""Auditoria de teclado/ARIA/responsive con Python Playwright (Chromium
real) + axe-core (obtenido via `npm pack axe-core` a work/axe-tmp/, NO una
dependencia de runtime). Matriz: 5 estados (Historia, Explorar, Peru, Accesible, DJ)
x 2 idiomas (es/en) x 2 viewports (360x800, 1280x720), con axe.run() en
cada estado, mas acciones reales de teclado:

- Tab natural desde el inicio hasta una pestana, y dentro de Accesible
  hasta acc-lat -> acc-lon -> acc-period -> Consultar (sin focus() directo
  en esa ruta; cada parada se registra y se valida).
- Ctrl+A antes de escribir coordenadas; periodo 2023-01 elegido en
  #acc-period con ArrowUp/ArrowDown; Enter sobre Consultar; el resultado
  debe contener coordenadas y periodo ESCRITOS (no el texto inicial) y la
  linea de tiempo debe mostrar 2023/01; #acc-form-error vacio.
- Activar sonido (Enter), Silencio (Espacio, aria-pressed cambia y se
  restaura), volumen (ArrowDown cambia el valor), DJ Reproducir/Detener
  (Enter, aria-pressed), Compartir (Enter -> share-url no vacio,
  decodificable con decodePreset de produccion) y recarga con ese enlace
  SIN autoplay (audio sin activar, DJ sin reproducir).

Los pasos que usan focus() directo (activar una pestana, mute, volumen,
DJ, compartir) se etiquetan "foco directo"; solo la ruta Accesible es Tab
natural. La consulta NASA POWER del panel DJ se atiende con el snapshot
publico tests/fixtures/demo-point-evidence (page.route): ninguna llamada
de red a POWER por ejecucion. Un fallo de axe, un timeout de accion o un
estado no confirmado cuentan como FAIL (nunca como "0 violaciones").

    npx vite --port 5181 --host 127.0.0.1
    py -3 scripts/verify_accessibility.py --base-url http://127.0.0.1:5181

No reclama NVDA/JAWS/VoiceOver ni telefono fisico: DOM/ARIA/contraste/
foco/tamano de objetivo via axe-core + Playwright.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
AXE_PATH = ROOT / "work" / "axe-tmp" / "package" / "axe.min.js"
POWER_FIXTURE = ROOT / "tests" / "fixtures" / "demo-point-evidence" / "power_75.19_-133.67_2023.json"

VIEWPORTS = [("mobile-360x800", 360, 800), ("desktop-1280x720", 1280, 720)]
LANGS = ["es", "en"]
TABS = ["history", "explore", "peru", "accessible", "dj"]
ACTION_TIMEOUT_MS = 8000


class Check:
    def __init__(self) -> None:
        self.results: list[tuple[str, bool, str]] = []
        self.t0 = time.monotonic()

    def ok(self, name: str, passed: bool, detail: str = "") -> None:
        self.results.append((name, bool(passed), detail))
        print(f"{'PASS' if passed else 'FAIL'} [{time.monotonic() - self.t0:5.0f}s] {name}{(' - ' + detail) if detail else ''}", flush=True)

    def summary(self) -> bool:
        failed = [r for r in self.results if not r[1]]
        print(f"\n{len(self.results) - len(failed)}/{len(self.results)} verificaciones OK")
        return len(failed) == 0


class Deadline:
    def __init__(self, seconds: float) -> None:
        self.end = time.monotonic() + seconds

    def expired(self) -> bool:
        return time.monotonic() > self.end


def guarded(check: Check, name: str, fn) -> None:
    """Un timeout/excepcion se registra como FAIL (estado no confirmado)."""
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        check.ok(name, False, f"estado no confirmado: {type(exc).__name__}: {str(exc).splitlines()[0][:160]}")


def run_axe(page) -> tuple[list[dict], int]:
    """Devuelve (violaciones, reglas_aprobadas). Si axe no se inyecta/ejecuta
    se PROPAGA la excepcion; reglas_aprobadas==0 se trata como 'no corrio'."""
    page.add_script_tag(path=str(AXE_PATH))
    page.wait_for_function("() => typeof window.axe !== 'undefined'", timeout=ACTION_TIMEOUT_MS)
    res = page.evaluate(
        """async () => {
            const r = await axe.run(document, { resultTypes: ['violations', 'passes'] });
            return { passes: r.passes.length,
                     violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })) };
        }"""
    )
    return res["violations"], res["passes"]


def axe_check(check: Check, page, label: str, what: str) -> None:
    def go():
        violations, passes = run_axe(page)
        check.ok(
            f"{label} axe.run() sin violaciones en {what}",
            passes > 0 and not violations,
            f"reglas_aprobadas={passes} violaciones={json.dumps(violations)[:400]}",
        )

    guarded(check, f"{label} axe.run() en {what}", go)


def wait_app_ready(page, timeout: int = ACTION_TIMEOUT_MS) -> None:
    page.wait_for_selector("#dj-panel", state="attached", timeout=timeout)
    page.wait_for_function(
        "() => { const el = document.getElementById('period-status'); return Boolean(el && el.textContent.trim().length > 0); }",
        timeout=timeout,
    )


def set_lang(page, lang: str) -> None:
    if page.evaluate("() => document.documentElement.lang") == lang:
        return
    page.locator(f"#lang-switch button[data-lang='{lang}']").click(timeout=ACTION_TIMEOUT_MS)
    page.wait_for_function(f"() => document.documentElement.lang === '{lang}'", timeout=ACTION_TIMEOUT_MS)


def focus_id(page) -> str:
    return page.evaluate(
        "() => { const a = document.activeElement; return a ? (a.id || a.dataset?.tab && 'tab:' + a.dataset.tab || a.tagName.toLowerCase() + (a.type ? ':' + a.type : '')) : ''; }"
    )


def tab_until(page, target: str, max_tabs: int = 60) -> list[str]:
    """Presiona Tab (natural) hasta que el foco sea `target` (id o 'tab:x' o
    'button:submit'); devuelve las paradas. Falla si no llega."""
    stops: list[str] = []
    for _ in range(max_tabs):
        page.keyboard.press("Tab")
        cur = focus_id(page)
        stops.append(cur)
        if cur == target:
            return stops
    raise RuntimeError(f"Tab no alcanzo {target} en {max_tabs} pulsaciones: {stops[-8:]}")


def open_tab(page, tab: str) -> None:
    page.locator(f".tab-btn[data-tab='{tab}']").focus(timeout=ACTION_TIMEOUT_MS)
    page.keyboard.press("Enter")
    page.wait_for_function(
        f"() => document.querySelector(\".tab-btn[data-tab='{tab}']\").getAttribute('aria-pressed') === 'true'",
        timeout=ACTION_TIMEOUT_MS,
    )
    panel = {"history": "history-panel", "explore": "explore-panel", "peru": "peru-panel", "accessible": "accessible-panel", "dj": "dj-panel"}[tab]
    page.wait_for_function(f"() => !document.getElementById('{panel}').hidden", timeout=ACTION_TIMEOUT_MS)


def audit_tabs(check: Check, page, label: str) -> None:
    def natural_tab():
        page.locator("body").click(position={"x": 2, "y": 2}, timeout=ACTION_TIMEOUT_MS)
        stops = tab_until(page, "tab:history")
        check.ok(f"{label} Tab natural (sin focus directo) alcanza la primera pestana", True, f"paradas={stops}")

    guarded(check, f"{label} Tab natural alcanza una pestana", natural_tab)

    for tab in TABS:
        def go(tab=tab):
            open_tab(page, tab)  # foco directo + Enter
            check.ok(f"{label} [foco directo] Enter activa pestana {tab} (aria-pressed=true, panel visible)", True)
            axe_check(check, page, label, f"pestana {tab}")

        guarded(check, f"{label} pestana {tab}", go)


def audit_accessible_form(check: Check, page, label: str, lang: str) -> None:
    def go():
        open_tab(page, "accessible")
        desc_before = page.text_content("#acc-description").strip()
        # Tab natural: desde la pestana Accesible hasta acc-lat (sin focus()).
        page.locator(".tab-btn[data-tab='accessible']").focus(timeout=ACTION_TIMEOUT_MS)
        stops = tab_until(page, "acc-lat")
        check.ok(f"{label} Tab natural desde la pestana Accesible llega a acc-lat", True, f"paradas={stops}")
        page.keyboard.press("Control+A")
        page.keyboard.type("-3.75")
        tab_until(page, "acc-lon", 2)
        page.keyboard.press("Control+A")
        page.keyboard.type("-73.25")
        tab_until(page, "acc-period", 2)
        before = page.input_value("#acc-period")
        for _ in range(400):
            cur = page.input_value("#acc-period")
            if cur == "2023-01":
                break
            page.keyboard.press("ArrowUp" if cur > "2023-01" else "ArrowDown")
        chosen = page.input_value("#acc-period")
        check.ok(f"{label} periodo 2023-01 elegido con teclado en acc-period (antes {before})", chosen == "2023-01", chosen)
        stops2 = tab_until(page, "button:submit", 3)
        check.ok(f"{label} Tab natural acc-period -> Consultar (acc-variable deshabilitado se omite)", True, f"paradas={stops2}")
        lat_v, lon_v = page.input_value("#acc-lat"), page.input_value("#acc-lon")
        check.ok(f"{label} Ctrl+A+escritura dejo solo las coordenadas nuevas", (lat_v, lon_v) == ("-3.75", "-73.25"), f"{lat_v},{lon_v}")
        page.keyboard.press("Enter")
        page.wait_for_function(
            "() => /-3\\.75, -73\\.25/.test(document.getElementById('acc-description').textContent)"
            " && /2023-01/.test(document.getElementById('acc-description').textContent)",
            timeout=ACTION_TIMEOUT_MS,
        )
        desc = page.text_content("#acc-description").strip()
        check.ok(
            f"{label} Enter sobre Consultar: descripcion con coordenadas y periodo escritos (no el texto inicial)",
            desc != desc_before and "-3.75, -73.25" in desc and "2023-01" in desc,
            desc[:90],
        )
        err = page.text_content("#acc-form-error").strip()
        check.ok(f"{label} #acc-form-error vacio tras consulta valida", err == "", repr(err))
        ym = (page.input_value("#year-select"), page.input_value("#month-select"))
        check.ok(f"{label} linea de tiempo confirma 2023/01", ym == ("2023", "01"), str(ym))
        axe_check(check, page, label, "Accesible con resultado")

    guarded(check, f"{label} flujo Accesible", go)


def audit_audio_dj_share(check: Check, page, label: str, base_url: str) -> None:
    def audio():
        page.locator("#audio-toggle").focus(timeout=ACTION_TIMEOUT_MS)
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('audio-toggle').disabled", timeout=ACTION_TIMEOUT_MS)
        check.ok(f"{label} [foco directo] Enter en audio-toggle activa el sonido (boton queda deshabilitado)", True)

        page.locator("#mute-toggle").focus(timeout=ACTION_TIMEOUT_MS)
        a0 = page.get_attribute("#mute-toggle", "aria-pressed")
        page.keyboard.press("Space")
        a1 = page.get_attribute("#mute-toggle", "aria-pressed")
        page.keyboard.press("Space")
        a2 = page.get_attribute("#mute-toggle", "aria-pressed")
        check.ok(f"{label} [foco directo] Espacio en mute-toggle cambia aria-pressed y se restaura", (a0, a1, a2) == ("false", "true", "false"), f"{a0}->{a1}->{a2}")

        page.locator("#volume-slider").focus(timeout=ACTION_TIMEOUT_MS)
        v0 = int(page.input_value("#volume-slider"))
        page.keyboard.press("ArrowDown")
        v1 = int(page.input_value("#volume-slider"))
        check.ok(f"{label} [foco directo] ArrowDown en volume-slider baja el valor", v1 == v0 - 1, f"{v0}->{v1}")

    guarded(check, f"{label} audio/mute/volumen", audio)

    def dj():
        open_tab(page, "dj")
        page.locator("#dj-play-btn").focus(timeout=ACTION_TIMEOUT_MS)
        page.wait_for_function("() => !document.getElementById('dj-play-btn').disabled", timeout=ACTION_TIMEOUT_MS)
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('dj-play-btn').getAttribute('aria-pressed') === 'true'", timeout=ACTION_TIMEOUT_MS)
        axe_check(check, page, label, "DJ reproduciendo")
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('dj-play-btn').getAttribute('aria-pressed') === 'false'", timeout=ACTION_TIMEOUT_MS)
        check.ok(f"{label} [foco directo] Enter en dj-play-btn reproduce y detiene (aria-pressed true->false, sonido activado)", True)

    guarded(check, f"{label} DJ play/stop", dj)

    def share():
        page.locator("#share-save-btn").focus(timeout=ACTION_TIMEOUT_MS)
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('share-url').value.length > 0", timeout=ACTION_TIMEOUT_MS)
        url = page.input_value("#share-url")
        frag = re.search(r"[#&]p=([^&]+)", url)
        dec = (
            page.evaluate(
                "async (f) => { const m = await import('/src/sharing/preset.js'); const r = m.decodePreset(f); return { ok: r.ok, preset: r.preset ?? null }; }",
                frag.group(1),
            )
            if frag
            else {"ok": False}
        )
        check.ok(f"{label} [foco directo] Enter en share-save-btn: share-url no vacio y decodificable", bool(frag) and dec["ok"], url[-60:])
        fresh = page.context.new_page()
        fresh.set_default_timeout(30000)
        fresh.goto(url, wait_until="load", timeout=30000)
        wait_app_ready(fresh, timeout=30000)
        audio_off = not fresh.evaluate("() => document.getElementById('audio-toggle').disabled")
        playing = fresh.evaluate("() => document.getElementById('dj-play-btn')?.getAttribute('aria-pressed') === 'true'")
        check.ok(f"{label} recargar con el enlace compartido NO activa audio ni reproduce DJ (sin autoplay)", audio_off and not playing, f"audio_sin_activar={audio_off} dj_playing={playing}")
        fresh.close()

    guarded(check, f"{label} compartir", share)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:5181")
    parser.add_argument("--total-timeout", type=float, default=900.0, help="segundos; al excederse, FAIL")
    args = parser.parse_args()

    if not AXE_PATH.exists():
        print(
            f"ERROR: no se encontro {AXE_PATH}.\n"
            "  npm pack axe-core --pack-destination work/axe-tmp\n"
            "  tar -xzf work/axe-tmp/axe-core-*.tgz -C work/axe-tmp\n",
            file=sys.stderr,
        )
        return 1

    power_body = POWER_FIXTURE.read_text(encoding="utf-8")
    deadline = Deadline(args.total_timeout)
    check = Check()
    with sync_playwright() as p:
        for viewport_name, width, height in VIEWPORTS:
            for lang in LANGS:
                label = f"[{viewport_name}/{lang}]"
                if deadline.expired():
                    check.ok(f"{label} auditoria completada dentro del timeout total ({args.total_timeout:.0f}s)", False, "timeout total excedido")
                    continue
                browser = p.chromium.launch()  # uno por combinacion: evita acumular contextos WebGL/Cesium
                context = browser.new_context(viewport={"width": width, "height": height})
                context.route(
                    re.compile(r"https://power\.larc\.nasa\.gov/.*"),
                    lambda route: route.fulfill(status=200, content_type="application/json", body=power_body),
                )
                page = context.new_page()
                page.set_default_timeout(ACTION_TIMEOUT_MS)
                try:
                    page.goto(args.base_url, wait_until="load", timeout=30000)
                    wait_app_ready(page)
                    set_lang(page, lang)
                except Exception as exc:  # noqa: BLE001
                    check.ok(f"{label} app lista", False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:160]}")
                    browser.close()
                    continue
                audit_tabs(check, page, label)
                audit_accessible_form(check, page, label, lang)
                audit_audio_dj_share(check, page, label, args.base_url)
                try:
                    browser.close()
                except Exception:  # noqa: BLE001
                    pass

    check.ok("auditoria completada dentro del timeout total", not deadline.expired(), f"limite={args.total_timeout:.0f}s")
    return 0 if check.summary() else 1


if __name__ == "__main__":
    sys.exit(main())
