#!/usr/bin/env python3
"""Flujo acotado de "Tu historia con la Tierra" con Playwright (Chromium real).

    npx vite --port 5182 --host 127.0.0.1
    py -3 scripts/verify_history.py --base-url http://127.0.0.1:5182

Cubre: Iquitos (catalogo GeoNames local) + 1990-01 contra el ultimo periodo
real del manifiesto (2026-08) con valores leidos por separado de los JSON
publicos; validaciones; sin autoplay; escuchar antes/despues y secuencia
automatica con Detener/mute; cambio ES/EN; teclado natural; enlace compartido
(sin nombre ni dia); celda NULL; enlace directo a DJ sin pasar por Historia;
mobile 360x800 y desktop 1280x720 (globo, volumen y mute visibles); axe en
Historia. No reclama lector de pantalla real ni telefono fisico.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright  # noqa: E402

from verify_accessibility import ACTION_TIMEOUT_MS, Check, axe_check, guarded, tab_until, wait_app_ready  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GIS = ROOT / "public" / "data" / "gistemp"
VIEWPORTS = [("mobile-360x800", 360, 800), ("desktop-1280x720", 1280, 720)]
IQUITOS = (-3.749, -73.254)


def nearest(centers: list[float], x: float) -> int:
    return min(range(len(centers)), key=lambda i: abs(centers[i] - x))


def cell_value(period: str, lat: float, lon: float):
    d = json.loads((GIS / f"{period}.json").read_text(encoding="utf-8"))
    la, lo = nearest(d["axes"]["lat_centers"], lat), nearest(d["axes"]["lon_centers"], lon)
    return d["values"][la * len(d["axes"]["lon_centers"]) + lo]


def fmt(v: float) -> str:
    return f"+{v:.2f}" if v >= 0.005 else f"{v:.2f}"


def find_null_cell() -> tuple[float, float]:
    a = json.loads((GIS / "1880-01.json").read_text(encoding="utf-8"))
    b = json.loads((GIS / "2026-08.json").read_text(encoding="utf-8"))
    nlon = len(a["axes"]["lon_centers"])
    for i, (x, y) in enumerate(zip(a["values"], b["values"])):
        if x is None and y is not None:
            return a["axes"]["lat_centers"][i // nlon], a["axes"]["lon_centers"][i % nlon]
    raise RuntimeError("no hay celda NULL en 1880-01 con dato en 2026-08")


def text(page, sel: str) -> str:
    return (page.text_content(sel) or "").strip()


def wait_text(page, sel: str, pattern: str, timeout: int = ACTION_TIMEOUT_MS) -> None:
    page.wait_for_function(
        "([s, p]) => new RegExp(p).test((document.querySelector(s)?.textContent || ''))", arg=[sel, pattern], timeout=timeout
    )


def submit_story(page, query: str, month: str, year: str) -> None:
    page.fill("#history-place-q", query)
    page.keyboard.press("Enter")
    page.wait_for_selector("#history-place-results button", timeout=ACTION_TIMEOUT_MS)
    page.locator("#history-place-results button", has_text=re.compile("Iquitos")).first.click()
    page.select_option("#history-month", month)
    page.fill("#history-year", year)
    page.keyboard.press("Enter")
    page.wait_for_selector("#history-result:not([hidden])", timeout=ACTION_TIMEOUT_MS)


def run_viewport(check: Check, p, name: str, width: int, height: int, base_url: str) -> None:
    label = f"[{name}]"
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    page.set_default_timeout(ACTION_TIMEOUT_MS)
    page.goto(base_url, wait_until="load", timeout=30000)
    wait_app_ready(page)

    def initial():
        check.ok(f"{label} la ruta inicial es Tu historia (panel visible)", page.is_visible("#history-panel") and not page.is_visible("#explore-panel"))
        note = text(page, "#history-latest-note")
        check.ok(f"{label} muestra el ultimo mes real (agosto de 2026), no 'hoy'", "agosto de 2026" in note and "no es" in note, note)
        for sel in ("#globe-container", "#volume-slider", "#mute-toggle", "#audio-toggle"):
            box = page.locator(sel).bounding_box()
            check.ok(f"{label} {sel} visible con tamano real", bool(box) and box["width"] > 0 and box["height"] > 0, str(box))
        check.ok(f"{label} cargo el catalogo solo al buscar (no en el arranque)", not any("geonames" in r for r in loaded_urls))
        axe_check(check, page, label, "Historia vacia")

    loaded_urls: list[str] = []
    page.on("request", lambda r: loaded_urls.append(r.url) if "geonames" in r.url else None)
    page.reload(wait_until="load")
    wait_app_ready(page)
    guarded(check, f"{label} estado inicial", initial)

    def keyboard_path():
        page.locator("#history-place-q").focus()
        stops = tab_until(page, "history-submit", 8)
        check.ok(f"{label} Tab natural: busqueda -> Buscar -> 2 enlaces de creditos -> globo -> mes -> ano -> Ver mi historia", stops == ["history-place-search", "a", "a", "history-use-globe", "history-month", "history-year", "history-submit"], str(stops))

    guarded(check, f"{label} teclado", keyboard_path)

    def validations():
        page.fill("#history-year", "")
        page.locator("#history-submit").click()
        wait_text(page, "#history-form-error", "lugar")
        page.fill("#history-year", "2099")
        page.select_option("#history-month", "1")
        page.locator("#history-submit").click()
        wait_text(page, "#history-form-error", "lugar")
        check.ok(f"{label} sin lugar elegido: error claro y no hay resultado", page.is_hidden("#history-result"))

    guarded(check, f"{label} validacion de lugar", validations)

    def flow():
        submit_story(page, "iquit", "1", "1990")
        check.ok(f"{label} se cargo el catalogo GeoNames en la primera busqueda", any("geonames-cities" in r for r in loaded_urls))
        page.wait_for_timeout(1000)
        check.ok(f"{label} tras Ver mi historia el foco queda en el titulo del resultado", page.evaluate("() => document.activeElement?.id") == "history-result-title")
        listen_box = page.locator("#history-listen-a").bounding_box()
        bar_box = page.locator("#audio-controls").bounding_box()
        vh = page.viewport_size["height"]
        check.ok(f"{label} primer boton Escuchar visible bajo la barra de audio sin mas scroll", bool(listen_box) and listen_box["y"] >= bar_box["y"] + bar_box["height"] - 1 and listen_box["y"] + listen_box["height"] <= vh, f"listen={listen_box} bar={bar_box} vh={vh}")
        check.ok(f"{label} sin desbordamiento horizontal", page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth"))
        summ = text(page, "#history-summary")
        check.ok(f"{label} resumen compacto antes/despues/diferencia/referencia", all(w in summ for w in ("Antes", "Después", "Diferencia", "1951–1980")), summ)
        check.ok(f"{label} aviso breve visible: anomalias, no clima del dia ni tendencia", "no el clima exacto del día" in text(page, "#history-short-note"))
        check.ok(f"{label} el relato y la tabla estan plegados en detalles", not page.evaluate("() => document.getElementById('history-details').open") and page.is_hidden("#history-data"))
        page.locator("#history-details > summary").focus()
        page.keyboard.press("Enter")
        check.ok(f"{label} Enter abre 'Ver datos y como interpretarlos'", page.evaluate("() => document.getElementById('history-details').open") and page.is_visible("#history-data"))
        page.keyboard.press("Space")
        check.ok(f"{label} Espacio lo cierra", not page.evaluate("() => document.getElementById('history-details').open"))
        page.keyboard.press("Enter")
        panel_text = text(page, "#history-panel")
        check.ok(f"{label} sin SHA, zip ni fecha de preparacion en la UI; credito GeoNames junto al buscador", "SHA" not in panel_text and "cities15000" not in panel_text and "preparado" not in panel_text and page.is_visible("#history-place-help ~ p a"))
        story = text(page, "#history-story")
        data = text(page, "#history-data")
        a = cell_value("1990-01", *IQUITOS)
        b = cell_value("2026-08", *IQUITOS)
        check.ok(f"{label} anomalia 1990-01 coincide con el JSON ({fmt(a)})", a is not None and fmt(a) in story, story[:200])
        check.ok(f"{label} anomalia 2026-08 coincide con el JSON ({fmt(b)})", b is not None and fmt(b) in story)
        check.ok(f"{label} diferencia correcta {fmt(round(b - a, 4))} °C", fmt(round(b - a, 4)) in story)
        check.ok(f"{label} sin % ni causa/tendencia afirmada", "%" not in story and "demuestra que" not in story)
        check.ok(f"{label} muestra 1951–1980, 'agosto de 2026' y 'no es la temperatura del día'", "1951–1980" in story and "agosto de 2026" in story and "no es la temperatura del día" in story)
        check.ok(f"{label} tabla de datos con celda, fuente y diferencia", "Diferencia" in data and "GISTEMP" in data)
        check.ok(f"{label} sin autoplay: audio sin activar", not page.evaluate("() => document.getElementById('audio-toggle').disabled"))
        check.ok(f"{label} botones de escucha deshabilitados con aviso hasta activar sonido", page.is_disabled("#history-listen-a") and "Activar sonido" in text(page, "#history-audio-hint"))
        check.ok(f"{label} preguntas guia y 'Cómo escucharlo' visibles", "Cómo escucharlo" in text(page, "#history-learn") and "¿qué cambió" in text(page, "#history-learn").lower())
        axe_check(check, page, label, "Historia con resultado")

    guarded(check, f"{label} Iquitos 1990-01", flow)

    def listening():
        page.locator("#audio-toggle").focus()
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('audio-toggle').disabled")
        page.wait_for_function("() => !document.getElementById('history-listen-a').disabled")
        page.locator("#history-listen-a").focus()
        page.keyboard.press("Enter")
        wait_text(page, "#history-play-status", "Sonando: Antes")
        page.wait_for_function("() => document.getElementById('year-select').value === '1990'")
        check.ok(f"{label} Escuchar antes: anuncia la epoca y la linea de tiempo/globo pasan a 1990", True, text(page, "#history-play-status"))
        check.ok(f"{label} detener, mute y volumen siguen visibles mientras suena", page.is_visible("#history-stop") and page.is_visible("#mute-toggle") and page.is_visible("#volume-slider"))
        page.locator("#history-stop").focus()
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('history-play-status').textContent.trim() === ''")
        check.ok(f"{label} Detener corta la escucha", True)
        page.locator("#history-listen-a").focus()
        page.keyboard.press("Enter")
        wait_text(page, "#history-play-status", "Sonando: Antes")
        page.locator("#history-year").press("End")
        page.locator("#history-year").press("Backspace")
        page.wait_for_function("() => document.getElementById('history-result').hidden")
        check.ok(f"{label} editar la fecha mientras suena detiene el audio y descarta el resultado viejo", page.is_hidden("#history-result"))
        page.locator("#history-year").fill("1990")
        page.locator("#history-form").evaluate("f => f.requestSubmit()")
        page.wait_for_function("() => !document.getElementById('history-result').hidden && !document.getElementById('history-listen-auto').disabled")
        page.locator("#history-listen-a").focus()
        page.keyboard.press("Enter")
        wait_text(page, "#history-play-status", "Sonando: Antes")
        page.evaluate("() => document.getElementById('history-stop').click()")
        page.wait_for_function("() => document.getElementById('history-play-status').textContent.trim() === ''")
        page.locator("#history-listen-auto").focus()
        page.keyboard.press("Enter")
        wait_text(page, "#history-play-status", "Sonando: Antes")
        page.locator("#mute-toggle").focus()
        page.keyboard.press("Space")
        page.wait_for_function("() => document.getElementById('history-play-status').textContent.trim() === ''")
        check.ok(f"{label} silenciar durante la secuencia automatica la corta", page.is_disabled("#history-listen-a"))
        page.keyboard.press("Space")
        page.locator("#history-listen-b").focus()
        page.keyboard.press("Enter")
        wait_text(page, "#history-play-status", "Sonando: Después")
        page.locator(".tab-btn[data-tab='dj']").focus()
        page.keyboard.press("Enter")
        page.wait_for_function("() => document.getElementById('dj-panel') && !document.getElementById('dj-panel').hidden")
        page.locator(".tab-btn[data-tab='history']").focus()
        page.keyboard.press("Enter")
        page.wait_for_selector("#history-result:not([hidden])")
        check.ok(f"{label} salir de la pestana detiene la escucha (no sigue sonando)", text(page, "#history-play-status") == "")

    guarded(check, f"{label} escuchar antes/despues", listening)

    def share_and_lang():
        page.locator("#share-save-btn").click()
        page.wait_for_function("() => document.getElementById('share-url').value.length > 0")
        url = page.input_value("#share-url")
        frag = re.search(r"[#&]p=([^&]+)", url).group(1)
        dec = page.evaluate("async (f) => { const m = await import('/src/sharing/preset.js'); return m.decodePreset(f); }", frag)
        pr = dec.get("preset", {})
        check.ok(f"{label} el enlace guarda modo history, dos periodos y punto", dec["ok"] and pr.get("mode") == "history" and pr["history"] == {"a": "1990-01", "b": "2026-08"}, json.dumps(pr)[:160])
        raw = page.evaluate("(f) => atob(f.replace(/-/g,'+').replace(/_/g,'/'))", frag)
        check.ok(f"{label} el enlace no contiene nombre de ciudad ni dia", "Iquitos" not in raw and not re.search(r"1990-01-\d\d", raw))
        fresh = context.new_page()
        fresh.set_default_timeout(30000)
        fresh.goto(url, wait_until="load", timeout=30000)
        wait_app_ready(fresh, timeout=30000)
        fresh.wait_for_selector("#history-result:not([hidden])", timeout=30000)
        check.ok(f"{label} abrir el enlace restaura formulario y resultado sin audio", fresh.input_value("#history-year") == "1990" and not fresh.evaluate("() => document.getElementById('audio-toggle').disabled") and text(fresh, "#history-play-status") == "")
        fresh.close()
        page.locator("#lang-switch button[data-lang='en']").click()
        page.wait_for_function("() => document.documentElement.lang === 'en'")
        wait_text(page, "#history-result-title", "Your story")
        en_story = text(page, "#history-story")
        check.ok(f"{label} cambio ES->EN traduce relato y fecha (August 2026)", "August 2026" in en_story and "relative to" in en_story, en_story[:120])
        axe_check(check, page, label, "Historia EN con resultado")
        page.locator("#lang-switch button[data-lang='es']").click()
        page.wait_for_function("() => document.documentElement.lang === 'es'")

    guarded(check, f"{label} compartir e idioma", share_and_lang)

    def same_and_null():
        page.select_option("#history-month", "8")
        page.fill("#history-year", "2026")
        page.locator("#history-submit").click()
        wait_text(page, "#history-story", "mismo mes")
        story = text(page, "#history-story")
        check.ok(f"{label} mismo periodo: diferencia 0.00 legitima", "0.00 °C" in story and "mismo mes" in story, story[-160:])
        page.fill("#history-year", "2027")
        page.locator("#history-submit").click()
        wait_text(page, "#history-form-error", "posterior")
        check.ok(f"{label} fecha futura rechazada con aviso (aria-invalid)", page.get_attribute("#history-year", "aria-invalid") == "true")
        page.fill("#history-year", "1879")
        page.locator("#history-submit").click()
        wait_text(page, "#history-form-error", "empiezan en")
        lat, lon = find_null_cell()
        url = page.evaluate(
            """async ([lat, lon]) => { const m = await import('/src/sharing/preset.js');
              return location.origin + '/#p=' + m.encodePreset({ mode: 'history', selectedPoint: { lat, lon }, period: '2026-08', lang: 'es', history: { a: '1880-01', b: '2026-08' } }); }""",
            [lat, lon],
        )
        n = context.new_page()
        n.set_default_timeout(30000)
        n.goto(url, wait_until="load", timeout=30000)
        wait_app_ready(n, timeout=30000)
        n.wait_for_selector("#history-result:not([hidden])", timeout=30000)
        ns = text(n, "#history-story")
        check.ok(f"{label} celda NULL: 'Sin dato', diferencia no disponible, sin musica inventada", "Sin dato" in ns and "no está disponible" in ns and n.is_disabled("#history-listen-a") and n.is_disabled("#history-listen-auto"), ns[:180])
        dd = text(n, "#history-data")
        check.ok(f"{label} la tabla muestra Sin dato y no un 0 inventado", "Sin dato" in dd)
        n.close()
        dj = context.new_page()
        dj.set_default_timeout(30000)
        durl = page.evaluate(
            """async () => { const m = await import('/src/sharing/preset.js');
              return location.origin + '/#p=' + m.encodePreset({ mode: 'dj', selectedPoint: { lat: -3.75, lon: -73.25 }, period: '2023-01', lang: 'es', seed: 'abc', bpm: 80 }); }"""
        )
        dj.goto(durl, wait_until="load", timeout=30000)
        wait_app_ready(dj, timeout=30000)
        check.ok(f"{label} enlace directo a DJ abre DJ sin forzar Historia", dj.is_visible("#dj-panel") and not dj.is_visible("#history-panel"))
        dj.close()

    guarded(check, f"{label} mismo mes, futuro, NULL, DJ directo", same_and_null)
    browser.close()


def run_late_response(check: Check, p, base_url: str) -> None:
    """Enlace history con 1990-01 retrasado -> clic real en el globo (punto B) -> la respuesta vieja llega tarde."""
    label = "[late-response]"
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 720})
    page = context.new_page()
    page.set_default_timeout(ACTION_TIMEOUT_MS)
    page.goto(base_url, wait_until="load", timeout=30000)
    wait_app_ready(page)
    url = page.evaluate(
        """async ([lat, lon]) => { const m = await import('/src/sharing/preset.js');
          return location.origin + '/#p=' + m.encodePreset({ mode: 'history', selectedPoint: { lat, lon }, period: '2026-08', lang: 'es', history: { a: '1990-01', b: '2026-08' } }); }""",
        list(IQUITOS),
    )
    held: list = []
    served: list[str] = []

    def delay_a(route):
        held.append(route)

    p2 = context.new_page()
    p2.set_default_timeout(ACTION_TIMEOUT_MS)
    p2.route("**/data/gistemp/1990-01.json", delay_a)
    p2.on("response", lambda r: served.append(r.url) if "gistemp/1990-01" in r.url else None)
    p2.goto(url, wait_until="load", timeout=30000)
    p2.wait_for_selector("#globe-container canvas", timeout=30000)
    deadline_ok = False
    for _ in range(100):
        if held:
            deadline_ok = True
            break
        p2.wait_for_timeout(100)
    check.ok(f"{label} la respuesta A (1990-01) queda retenida por page.route", deadline_ok)
    check.ok(f"{label} sigue la pestana Historia y no hay resultado todavia", p2.is_visible("#history-panel") and p2.is_hidden("#history-result"))
    # Antes de soltar A todavia no hay dataset (el arranque espera al enlace),
    # asi que point-info esta oculto: el punto se lee del DOM de #acc-description.
    def acc() -> str:
        return (p2.text_content("#acc-description") or "").strip()

    box = p2.locator("#globe-container").bounding_box()
    x, y = box["x"] + box["width"] / 2 + 40, box["y"] + box["height"] / 2 + 30
    p2.mouse.move(x, y)
    p2.mouse.down()
    p2.mouse.up()
    p2.wait_for_function(
        "() => /[0-9]/.test(document.getElementById('acc-description')?.textContent || '')", timeout=15000
    )
    desc_b = acc()
    iq_lat = f"{IQUITOS[0]:.2f}"
    check.ok(f"{label} el clic real en el canvas fijo el punto B (DOM acc-description)", iq_lat not in desc_b, desc_b[:120])
    for route in held:
        route.continue_()
    for _ in range(100):
        if served:
            break
        p2.wait_for_timeout(100)
    check.ok(f"{label} la respuesta A vieja llego despues del clic", bool(served), str(served))
    p2.wait_for_function("() => !document.getElementById('point-details').hidden", timeout=30000)
    p2.wait_for_timeout(2500)
    coords_b = (p2.text_content("#field-coords") or "").strip()
    desc_after = acc()
    check.ok(f"{label} point-info sigue en B tras la respuesta A (no vuelve a Iquitos)", bool(coords_b) and iq_lat not in coords_b and desc_after == desc_b or (bool(coords_b) and iq_lat not in coords_b and iq_lat not in desc_after), f"point-info={coords_b!r} acc={desc_after[:80]!r}")
    check.ok(f"{label} el resultado viejo de Historia no esta activo", p2.is_hidden("#history-result") and text(p2, "#history-story") == "")
    check.ok(f"{label} sin audio ni escucha automatica", text(p2, "#history-play-status") == "" and p2.evaluate("() => !document.getElementById('audio-toggle').disabled"))
    check.ok(f"{label} sigue la pestana Historia", p2.is_visible("#history-panel"))
    browser.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:5182")
    ap.add_argument("--scenario", choices=["all", "late-response"], default="all")
    args = ap.parse_args()
    check = Check()
    with sync_playwright() as p:
        if args.scenario == "late-response":
            guarded(check, "[late-response] escenario", lambda: run_late_response(check, p, args.base_url))
            return 0 if check.summary() else 1
        for name, w, h in VIEWPORTS:
            run_viewport(check, p, name, w, h, args.base_url)
        guarded(check, "[late-response] escenario", lambda: run_late_response(check, p, args.base_url))
    return 0 if check.summary() else 1


if __name__ == "__main__":
    sys.exit(main())
