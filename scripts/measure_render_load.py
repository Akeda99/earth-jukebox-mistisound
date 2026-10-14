"""Mide si el globo renderiza de forma continua en reposo (scene.frameState.frameNumber).

Uso: py -3 scripts/measure_render_load.py --base-url http://localhost:5181
Requiere el servidor de desarrollo (window.__ejViewer solo existe en DEV).
Con requestRenderMode el globo en reposo (tiles cargados) debe avanzar 0
frames; arrastrar, zoom, flyTo programatico, cambio de fecha (overlay) y el
marcador de punto deben seguir produciendo frames.
"""
import argparse, json
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--base-url', default='http://localhost:5181')
args = ap.parse_args()

FRAME = 'window.__ejViewer.scene.frameState.frameNumber'
results = {}
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    page.goto(args.base_url, wait_until='load')
    page.wait_for_function('window.__ejViewer && window.__ejViewer.scene', timeout=60000)

    def settle(max_s=40):
        last, stable = -1, 0
        for _ in range(max_s * 2):
            page.wait_for_timeout(500)
            cur = page.evaluate(FRAME)
            stable = stable + 1 if cur == last else 0
            last = cur
            if stable >= 6:
                return True
        return False

    results['requestRenderMode'] = page.evaluate('window.__ejViewer.scene.requestRenderMode')
    results['settled_after_load'] = settle()
    f0 = page.evaluate(FRAME); page.wait_for_timeout(5000)
    results['idle_frames_5s'] = page.evaluate(FRAME) - f0

    def delta(label, action, wait=2500):
        before = page.evaluate(FRAME); action(); page.wait_for_timeout(wait)
        results[label] = page.evaluate(FRAME) - before

    cam0 = page.evaluate('window.__ejViewer.camera.positionCartographic.longitude')
    delta('drag_frames', lambda: (page.mouse.move(640, 400), page.mouse.down(), page.mouse.move(760, 420, steps=8), page.mouse.up()))
    results['drag_moved_camera'] = abs(page.evaluate('window.__ejViewer.camera.positionCartographic.longitude') - cam0) > 1e-6
    delta('zoom_frames', lambda: page.mouse.wheel(0, -600))
    cam1 = page.evaluate('window.__ejViewer.camera.positionCartographic.latitude')
    delta('flyTo_frames', lambda: page.evaluate("""() => { const v = window.__ejViewer; const C = v.camera.position.constructor;
        v.camera.flyTo({destination: new C(-1500000, -5500000, -1500000), duration: 1.0}); }"""), wait=3000)
    results['flyTo_moved_camera'] = abs(page.evaluate('window.__ejViewer.camera.positionCartographic.latitude') - cam1) > 1e-6
    settle()
    layers0 = page.evaluate('window.__ejViewer.imageryLayers.length')
    delta('date_change_frames', lambda: page.select_option('#month-select', index=3), wait=5000)
    settle()
    results['imagery_layers_before_after'] = [layers0, page.evaluate('window.__ejViewer.imageryLayers.length')]
    ents0 = page.evaluate('window.__ejViewer.entities.values.length')
    delta('point_marker_frames', lambda: page.mouse.click(640, 400), wait=3000)
    results['entities_before_after'] = [ents0, page.evaluate('window.__ejViewer.entities.values.length')]
    settle()
    f0 = page.evaluate(FRAME); page.wait_for_timeout(5000)
    results['idle_frames_after_interactions_5s'] = page.evaluate(FRAME) - f0
    print(json.dumps(results, indent=2))
    browser.close()
