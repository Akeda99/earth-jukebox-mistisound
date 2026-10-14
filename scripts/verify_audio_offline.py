#!/usr/bin/env python3
"""Verificacion de audio REAL contra los modulos de PRODUCCION de
AudioEngine/DjMixer (src/audio/engine.js, src/audio/mixer.js), usando
Tone.Offline (OfflineAudioContext real) dentro de Chromium headless via
Python Playwright. NO es un mock: los sintetizadores/limiter/Transport son
instancias reales de Tone.js, renderizadas a un buffer de audio real.

Requiere un servidor Vite dev sirviendo este proyecto (para resolver los
imports ESM de src/ y 'tone' sin empaquetar):
    npx vite --port 5181
y luego:
    py -3 scripts/verify_audio_offline.py --base-url http://localhost:5181

Ver docs/audio-verification.md para el detalle de la adaptacion necesaria
(Transport/Destination/now/Time capturados del `context` real que
Tone.Offline() pasa al callback) y los DOS hallazgos reales que la
motivaron (uno de ellos corregido en una revision posterior: el primer
intento con `now`/`Time` dinamicos todavia usaba el reloj del contexto EN
VIVO original durante la fase tardia del render offline).

Guarda outputs/earth-jukebox-demo.wav: UN punto/mes real concreto
(Artico 75.19N/-133.67W, diciembre 2023), no valores de fixture
inventados — ver seccion 7 abajo para las fuentes exactas.
"""

from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HARNESS_PATH = "/tests/browser/audio-harness.html"
DEMO_WAV_PATH = ROOT.parent.parent / "outputs" / "earth-jukebox-demo.wav"

PENTATONIC_SCALE = [f"{deg}{octv}" for octv in range(3, 7) for deg in ["C", "D", "E", "G", "A"]]
SEMITONE = {"C": 0, "D": 2, "E": 4, "G": 7, "A": 9}


def note_index(note: str) -> int:
    return PENTATONIC_SCALE.index(note)


def note_to_hz(note: str) -> float:
    """12-TET estandar, A4=440Hz (igual convencion que Tone.Frequency()).
    Independiente de audio-harness.js: no reutiliza su tabla NOTE_FREQS."""
    letter = note[:-1]
    octave = int(note[-1])
    midi = (octave + 1) * 12 + SEMITONE[letter]
    return 440.0 * 2 ** ((midi - 69) / 12)


def expected_step_for_anomaly(anomaly: float, steps: int) -> int:
    """Mapeo musical v2 reimplementado de forma independiente: rango fijo
    [-12, 12] K, compresion asinh (escala 2), cuantizacion a `steps` pasos."""
    clamped = max(-12.0, min(12.0, anomaly))
    unit = np.arcsinh(clamped / 2.0) / np.arcsinh(6.0)
    return int(np.floor(((unit + 1.0) / 2.0) * (steps - 1) + 0.5))


def expected_note_for_anomaly(anomaly: float) -> str:
    return PENTATONIC_SCALE[expected_step_for_anomaly(anomaly, len(PENTATONIC_SCALE))]


def hps_fundamental(samples, sample_rate, fmin=100.0, fmax=1800.0, harmonics=4):
    """Frecuencia fundamental por producto armonico espectral (HPS): evita
    confundir un armonico fuerte con la fundamental."""
    arr = np.asarray(samples, dtype=np.float64)
    arr = arr * np.hanning(len(arr))
    n = len(arr) * 4
    spec = np.abs(np.fft.rfft(arr, n))
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    hps = spec.copy()
    for h in range(2, harmonics + 1):
        dec = spec[::h]
        hps[: len(dec)] *= dec
        hps[len(dec):] = 0
    band = (freqs >= fmin) & (freqs <= fmax)
    idx = int(np.argmax(np.where(band, hps, 0)))
    return float(freqs[idx])


DEMO_LAT, DEMO_LON, DEMO_PERIOD = 75.19, -133.67, "2023-12"
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "demo-point-evidence"


def _nearest_index(centers: list[float], value: float) -> int:
    return min(range(len(centers)), key=lambda i: abs(centers[i] - value))


def _grid_value(doc: dict, lat: float, lon: float) -> tuple[int, float | None]:
    lats, lons = doc["axes"]["lat_centers"], doc["axes"]["lon_centers"]
    idx = _nearest_index(lats, lat) * len(lons) + _nearest_index(lons, lon)
    if len(doc["values"]) != len(lats) * len(lons):
        raise ValueError("values no coincide con axes")
    return idx, doc["values"][idx]


def load_demo_params() -> tuple[dict, list[str]]:
    """Lee GISTEMP + hielo + snapshot POWER y valida periodo, celda,
    cobertura, unidad y SHA256 del sidecar. Lanza ValueError si algo no
    coincide (el demo no se genera con datos sin confirmar)."""
    import hashlib
    import json

    gistemp = json.loads((ROOT / "public/data/gistemp/2023-12.json").read_text(encoding="utf-8"))
    ice = json.loads((ROOT / "public/data/sea-ice-g02135/2023-12.json").read_text(encoding="utf-8"))
    meta = json.loads((FIXTURE_DIR / "power_75.19_-133.67_2023.meta.json").read_text(encoding="utf-8"))
    power_bytes = (FIXTURE_DIR / meta["file"]).read_bytes()
    power = json.loads(power_bytes)

    if gistemp["period"] != DEMO_PERIOD or ice["period"] != DEMO_PERIOD:
        raise ValueError("periodo GISTEMP/hielo != 2023-12")
    if hashlib.sha256(power_bytes).hexdigest() != meta["sha256"]:
        raise ValueError("SHA256 del snapshot POWER no coincide con el sidecar")
    if power["parameters"]["PRECTOTCORR"]["units"] != meta["unit"] or meta["unit"] != "mm/day":
        raise ValueError("unidad POWER inesperada")
    if power["geometry"]["coordinates"][:2] != [meta["point"]["longitude"], meta["point"]["latitude"]]:
        raise ValueError("punto POWER no coincide con el sidecar")
    if (meta["point"]["latitude"], meta["point"]["longitude"]) != (DEMO_LAT, DEMO_LON):
        raise ValueError("punto del sidecar != punto del demo")

    g_idx, temp = _grid_value(gistemp, DEMO_LAT, DEMO_LON)
    i_idx, ice_frac = _grid_value(ice, DEMO_LAT, DEMO_LON)
    if temp is None or ice_frac is None or g_idx != i_idx:
        raise ValueError("celda GISTEMP/hielo ausente o no coincidente")
    coverage = ice["coverage"][i_idx]
    if coverage <= 0:
        raise ValueError("celda de hielo sin cobertura")
    rain = power["properties"]["parameter"]["PRECTOTCORR"]["202312"]
    if rain != meta["demo_value"] or rain < 0:
        raise ValueError("PRECTOTCORR 202312 no coincide con el sidecar")

    lat_c = gistemp["axes"]["lat_centers"][_nearest_index(gistemp["axes"]["lat_centers"], DEMO_LAT)]
    lon_c = gistemp["axes"]["lon_centers"][_nearest_index(gistemp["axes"]["lon_centers"], DEMO_LON)]
    params = {
        "temperatureAnomalyK": float(temp),
        "rainMmDay": float(rain),
        "iceFraction": float(ice_frac),
        "seed": "demo-wav-2023-12-arctic",
    }
    prov = [
        f"GISTEMP {gistemp['period']} celda({lat_c:g},{lon_c:g}) = {temp} K (source sha {gistemp['source']['original_file_sha256'][:8]}...)",
        f"hielo G02135 {ice['period']} celda({lat_c:g},{lon_c:g}) = {ice_frac} cobertura={coverage}px (version_hash {ice['version_hash'][:8]}...)",
        f"POWER PRECTOTCORR 202312 = {rain} {meta['unit']} punto({DEMO_LAT},{DEMO_LON}) sha256 {meta['sha256'][:8]}... fixture {meta['fetch_date']}",
        f"nota: {temp} K esta dentro del rango musical fijo -12..12 (version musical 2): NO satura; registro {expected_step_for_anomaly(float(temp), 16) + 1} de 16 (el rango de color -5..5 de la leyenda es distinto)",
    ]
    return params, prov


class Check:
    def __init__(self) -> None:
        self.results: list[tuple[str, bool, str]] = []

    def ok(self, name: str, passed: bool, detail: str = "") -> None:
        self.results.append((name, passed, detail))
        print(f"{'PASS' if passed else 'FAIL'}  {name}{(' - ' + detail) if detail else ''}")

    def summary(self) -> bool:
        failed = [r for r in self.results if not r[1]]
        print(f"\n{len(self.results) - len(failed)}/{len(self.results)} verificaciones OK")
        return len(failed) == 0


def write_wav(path: Path, sample_rate: int, channels: list[list[float]]) -> None:
    n = len(channels[0])
    nch = len(channels)
    arrs = [np.clip(np.array(c, dtype=np.float64), -1.0, 1.0) for c in channels]
    interleaved = np.empty(n * nch, dtype=np.int16)
    for i, a in enumerate(arrs):
        interleaved[i::nch] = (a * 32767).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(nch)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(interleaved.tobytes())


def fft_peak_frequency(samples: list[float], sample_rate: int, fmin: float = 80.0, fmax: float = 2500.0) -> tuple[float, float]:
    """FFT real e independiente (numpy), buscando el pico general del
    espectro en una banda amplia (80-2500Hz, cubre toda la escala
    pentatonica C3-A6) en vez de limitarse a un conjunto predeterminado de
    frecuencias candidatas. Devuelve (frecuencia_pico_hz, magnitud_pico)."""
    arr = np.asarray(samples, dtype=np.float64)
    arr = arr * np.hanning(len(arr))  # reduce leakage espectral
    spectrum = np.abs(np.fft.rfft(arr))
    freqs = np.fft.rfftfreq(len(arr), d=1.0 / sample_rate)
    band = (freqs >= fmin) & (freqs <= fmax)
    band_spectrum = spectrum[band]
    band_freqs = freqs[band]
    peak_idx = int(np.argmax(band_spectrum))
    return float(band_freqs[peak_idx]), float(band_spectrum[peak_idx])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://localhost:5181")
    args = parser.parse_args()

    check = Check()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.goto(f"{args.base_url}{HARNESS_PATH}", wait_until="load", timeout=30000)
        page.wait_for_function("window.__audioHarnessReady === true", timeout=10000)

        # 1) Sanity: Tone.Offline realmente renderiza audio real (no 0, no NaN).
        ping = page.evaluate("async () => await window.AudioHarness.pingOffline()")
        expected_ping_rms = (1 / np.sqrt(2)) * np.sqrt(0.5 / 0.6)
        check.ok(
            "Tone.Offline renderiza una senoidal real (RMS teorico exacto, tono 0.5s + silencio 0.1s)",
            abs(ping["rms"] - expected_ping_rms) < 1e-3,
            f"got={ping['rms']:.6f} expected={expected_ping_rms:.6f}",
        )
        check.ok("buffer finito (sin NaN/Infinity)", ping["finite"])

        # 2) Temperatura -> nota: FFT INDEPENDIENTE (numpy) sobre la forma de
        #    onda cruda, buscando el pico espectral general (no limitado a
        #    frecuencias candidatas predeterminadas), comparado contra la
        #    nota/Hz ESPERADA recalculada independientemente (ver
        #    expected_note_for_anomaly/note_to_hz arriba).
        anomalies = [-12, -5, -2, 0, 2, 5, 6, 9, 12]
        fft_results = []
        for a in anomalies:
            raw = page.evaluate("async (a) => await window.AudioHarness.temperatureNoteRaw(a)", a)
            sample_rate = raw["sampleRate"]
            peak_hz, peak_mag = fft_peak_frequency(raw["samples"], sample_rate)
            expected_note = expected_note_for_anomaly(a)
            expected_hz = note_to_hz(expected_note)
            # Tolerancia: resolucion espectral real de esta ventana
            # (sample_rate / N), con margen x3 para la ventana Hanning +
            # el ataque/release de la envolvente (no son tonos puros
            # infinitos). Nunca una tolerancia floja fija sin relacion con
            # la resolucion real del analisis.
            freq_resolution = sample_rate / len(raw["samples"])
            tolerance_hz = max(3 * freq_resolution, 0.01 * expected_hz)
            hps_hz = hps_fundamental(raw["samples"], sample_rate)
            diff = abs(peak_hz - expected_hz)
            fft_results.append(
                {
                    "anomaly": a,
                    "expected_note": expected_note,
                    "expected_hz": expected_hz,
                    "peak_hz": peak_hz,
                    "diff_hz": diff,
                    "tolerance_hz": tolerance_hz,
                }
            )
            check.ok(
                f"temperatura anomalia={a}: pico FFT ({peak_hz:.2f}Hz) coincide con nota esperada {expected_note} ({expected_hz:.2f}Hz) dentro de tolerancia {tolerance_hz:.2f}Hz",
                diff <= tolerance_hz,
                f"diff={diff:.2f}Hz, resolucion_fft={freq_resolution:.3f}Hz",
            )
            check.ok(
                f"temperatura anomalia={a}: fundamental por HPS ({hps_hz:.2f}Hz) tambien coincide con {expected_note}",
                abs(hps_hz - expected_hz) <= tolerance_hz,
            )
        peak_hz_list = [r["peak_hz"] for r in fft_results]
        check.ok(
            "temperatura: mayor anomalia -> pico FFT igual o mas agudo (monotono, medido por FFT independiente)",
            all(peak_hz_list[i] >= peak_hz_list[i - 1] - 1.0 for i in range(1, len(peak_hz_list))),
            str([(r["anomaly"], round(r["peak_hz"], 1)) for r in fft_results]),
        )

        by_a = {r["anomaly"]: r["peak_hz"] for r in fft_results}
        check.ok("temperatura: 6 y 9 K suenan distinto (ya no saturan juntos)", by_a[9] > by_a[6] + 1.0, f"{by_a[6]:.1f} vs {by_a[9]:.1f}")
        check.ok("temperatura: -2 < 0 < 2 K", by_a[-2] < by_a[0] < by_a[2], f"{by_a[-2]:.1f} {by_a[0]:.1f} {by_a[2]:.1f}")

        # 3) Mute real: DJ continuo sobre Transport REALMENTE arrancado.
        #    Epsilon ESTRICTO (no una tolerancia floja que esconda un
        #    posible falso positivo): tras la rampa, silencio debe ser
        #    prácticamente exacto.
        mute = page.evaluate("async () => await window.AudioHarness.muteAfterRamp()")
        check.ok("mute: el callback de Transport.scheduleOnce SI se ejecuto", mute["muteCallbackFired"] is True, str(mute))
        check.ok("mute: engine.isMuted() es true tras el callback", mute["isMutedAfterCallback"] is True, str(mute))
        check.ok(
            "mute: la MISMA escena SIN mutear (control) SI suena despues del punto de mute (RMS>0)",
            mute["controlRms"] > 0.01,
            str(mute),
        )
        check.ok(
            "mute: con mute real, RMS tras la rampa es ~0 exacto (<=1e-7, epsilon estricto)",
            mute["mutedRms"] <= 1e-7,
            str(mute),
        )
        check.ok(
            "mute: con mute real, pico tras la rampa es ~0 exacto (<=1e-7, epsilon estricto)",
            mute["mutedPeak"] <= 1e-7,
            str(mute),
        )
        check.ok("mute: buffers finitos", mute["finite"])

        # 4) Hielo: "fade" continuo con la fraccion (presence = velocity),
        #    0.0 real (fuente bajo el umbral de deteccion del 15% de
        #    G02135, NO ausencia absoluta) es silencio real, no un error.
        fractions = [0.0, 0.25, 0.5, 0.75, 1.0]
        ice_results = [page.evaluate("async (f) => await window.AudioHarness.iceSingle(f)", f) for f in fractions]
        rmss = [r["rms"] for r in ice_results]
        check.ok("hielo: fraccion 0.0 real produce RMS ~ 0 (silencio real, no null)", rmss[0] < 1e-4, str(ice_results[0]))
        check.ok(
            "hielo: RMS crece ESTRICTAMENTE con la fraccion (.25 < .5 < .75 < 1), fade continuo sin corte binario",
            all(rmss[i] > rmss[i - 1] for i in range(1, len(rmss))),
            str([(r["fraction"], round(r["rms"], 5)) for r in ice_results]),
        )
        for r in ice_results:
            check.ok(f"hielo fraccion={r['fraction']}: buffer finito", r["finite"])

        # 5) Lluvia: mas mm/day -> mas "hits" ritmicos (semilla fija, reproducible).
        rain_values = [1, 5, 10, 20]
        rain_results = [page.evaluate("async (v) => await window.AudioHarness.rainHits(v)", v) for v in rain_values]
        hits = [r["hits"] for r in rain_results]
        check.ok(
            "lluvia: mas mm/day -> igual o mas hits (densidad ritmica real, semilla fija)",
            all(hits[i] >= hits[i - 1] for i in range(1, len(hits))),
            str([(r["rainValue"], r["hits"]) for r in rain_results]),
        )
        check.ok("lluvia: valor alto produce claramente mas hits que valor bajo", hits[-1] > hits[0])
        rain_repeat = page.evaluate("async (v) => await window.AudioHarness.rainHits(v)", rain_values[-1])
        check.ok(
            "lluvia: misma semilla + mismo dato -> mismo numero de hits (reproducible; NO se exige igualdad de bytes del ruido de NoiseSynth)",
            rain_repeat["hits"] == hits[-1],
            f"{rain_repeat['hits']} vs {hits[-1]}",
        )

        # 5b) Lluvia a BPM 48/72/96 con densidad maxima (20mm/day):
        #     el intervalo medio entre onsets debe escalar con el pulso
        #     real del Transport OFFLINE (bug real corregido: antes el
        #     offset de subdivision usaba el BPM 120 por defecto del
        #     contexto EN VIVO, no el BPM offline configurado).
        # A densidad 1 se disparan las 4 subdivisiones de cada pulso, asi
        # que el intervalo fundamental esperado es 60/bpm/4. La resolucion
        # del detector es de 5 ms; tolerancia = max(6 ms, 8%). Si el
        # detector pierde algun golpe, el intervalo observado es un multiplo
        # entero k del fundamental: se acepta k<=2 y se estima el
        # fundamental como la MEDIANA de los intervalos dividida por el k
        # mas cercano; se exige que >=70% de los intervalos coincidan con
        # k*fundamental esperado (no solo que "quepan" en un pulso).
        def tempo_metric(r):
            onsets = np.array(r["onsetTimesSec"], dtype=np.float64)
            expected = r["pulseSec"] / 4.0
            tol = max(0.006, 0.08 * expected)
            if len(onsets) < 10:
                return False, f"solo {len(onsets)} onsets (<10)", None, expected
            iv = np.diff(onsets)
            matched = 0
            for x in iv:
                if any(abs(x - k * expected) <= tol * k for k in (1, 2)):
                    matched += 1
            med = float(np.median(iv))
            k = max(1, round(med / expected))
            fundamental = med / k
            ok = (matched / len(iv) >= 0.70) and abs(fundamental - expected) <= tol
            return ok, (
                f"onsets={len(onsets)} mediana={med:.4f}s k={k} fundamental={fundamental:.4f}s "
                f"esperado={expected:.4f}s tol={tol:.4f}s coinciden={matched}/{len(iv)}"
            ), fundamental, expected

        fundamentals = {}
        for bpm in (48, 72, 96):
            r = page.evaluate(
                "async (args) => await window.AudioHarness.rainOnsetTimes(args.bpm, args.rainValue, args.seed)",
                {"bpm": bpm, "rainValue": 20, "seed": "bpm-scaling-harness"},
            )
            check.ok(f"lluvia BPM={bpm}: buffer finito", r["finite"])
            ok, detail, fund, _ = tempo_metric(r)
            fundamentals[bpm] = fund
            check.ok(f"lluvia BPM={bpm}: intervalo fundamental de onsets == 60/bpm/4", ok, detail)
        if all(v is not None for v in fundamentals.values()):
            check.ok(
                "lluvia: el intervalo fundamental escala inversamente con el BPM (48 > 72 > 96, ratio 48/96 ~ 2)",
                fundamentals[48] > fundamentals[72] > fundamentals[96]
                and abs(fundamentals[48] / fundamentals[96] - 2.0) < 0.2,
                str({k: round(v, 4) for k, v in fundamentals.items()}),
            )

        # Control negativo: adapter con el BUG de Time (usa el reloj en
        # vivo, BPM 120 por defecto) renderizando a BPM 48. La METRICA
        # debe FALLAR (fundamental ~0.125 s en vez de 0.3125 s).
        neg = page.evaluate(
            "async (args) => await window.AudioHarness.rainOnsetTimes(args.bpm, args.rainValue, args.seed, { brokenTimeAdapter: true })",
            {"bpm": 48, "rainValue": 20, "seed": "bpm-scaling-harness"},
        )
        neg_ok, neg_detail, neg_fund, neg_expected = tempo_metric(neg)
        check.ok(
            "control negativo: Transport que ignora el BPM (queda en 120) a BPM=48 FALLA la metrica de tempo",
            (not neg_ok) and neg_fund is not None and abs(neg_fund - 0.125) <= 0.02,
            neg_detail,
        )

        # 6) stop() no deja un loop fantasma sonando (ver audio/mixer.js).
        stop = page.evaluate("async () => await window.AudioHarness.stopCutsLoopedAudio()")
        check.ok(
            "stop(): cero onsets nuevos despues de la cola de release de la ultima nota",
            stop["onsetsAfterStopTail"] == 0,
            str(stop),
        )
        check.ok("stop(): RMS ~ 0 bien despues de la cola de release", stop["rmsAfterStopTail"] < 0.001, str(stop))

        # 7) Demo WAV REAL: UN punto/mes concreto (Artico 75.19N/-133.67W,
        #    diciembre 2023). Los parametros se DERIVAN de los archivos
        #    (GISTEMP JSON, hielo G02135 JSON, snapshot POWER con sidecar en
        #    tests/fixtures/demo-point-evidence/), no se escriben a mano.
        #    El snapshot POWER es solo para reproducir el demo; la app en
        #    vivo consulta la API POWER en tiempo real.
        demo_params, demo_prov = load_demo_params()
        for line in demo_prov:
            print(f"  demo fuente: {line}")
        comp_args = {
            "temperatureAnomalyK": demo_params["temperatureAnomalyK"],
            "rainMmDay": demo_params["rainMmDay"],
            "iceFraction": demo_params["iceFraction"],
            "seed": demo_params["seed"],
        }
        demo = page.evaluate("async (p) => await window.AudioHarness.compositionMix(p)", comp_args)
        write_wav(DEMO_WAV_PATH, demo["sampleRate"], demo["channels"])
        arrs = [np.array(c, dtype=np.float64) for c in demo["channels"]]
        sr = demo["sampleRate"]
        demo_finite = all(bool(np.all(np.isfinite(a))) for a in arrs)
        demo_peak = max(float(np.max(np.abs(a))) for a in arrs)
        print(f"  demo meta: {demo['meta']}")
        check.ok(f"demo WAV escrito en {DEMO_WAV_PATH}", DEMO_WAV_PATH.exists())
        check.ok("demo WAV: 2 canales", demo["numberOfChannels"] == 2, str(demo["numberOfChannels"]))
        check.ok("composicion: onEnd se disparo", demo["ended"] is True)
        check.ok(
            "composicion: onEnd a los 20.0 s (+-0.3 s) del reloj offline",
            demo["endedAt"] is not None and abs(demo["endedAt"] - 20.0) <= 0.3,
            f"endedAt={demo['endedAt']}",
        )
        check.ok("demo WAV: audio finito (sin NaN/Infinity)", demo_finite)
        check.ok("demo WAV: pico dentro de rango seguro (<0.9)", demo_peak < 0.9, f"peak={demo_peak:.4f}")
        rms0 = float(np.sqrt(np.mean(arrs[0] ** 2)))
        check.ok("demo WAV: no es silencio (RMS>0.005)", rms0 > 0.005, f"rms={rms0:.4f}")
        tail = arrs[0][int(22.0 * sr):]
        check.ok("demo WAV: cola final (22.0-22.5 s) casi silenciosa (<1e-3 RMS)", float(np.sqrt(np.mean(tail ** 2))) < 1e-3)
        h1 = float(np.sqrt(np.mean(arrs[0][: int(10.0 * sr)] ** 2)))
        h2 = float(np.sqrt(np.mean(arrs[0][int(10.0 * sr): int(20.0 * sr)] ** 2)))
        check.ok("demo WAV: hay energia en los primeros 10 s y en los ultimos 10 s", h1 > 0.005 and h2 > 0.005, f"{h1:.4f} {h2:.4f}")

        # 8) Piano de la composicion: fundamental (HPS) de la 1a nota, monotona.
        fundamentals_piano = {}
        for a in (-8, -2, 0, 2, 6, 9):
            r = page.evaluate(
                "async (a) => await window.AudioHarness.compositionMono(a)",
                {"temperatureAnomalyK": a, "renderSeconds": 1.0, "seed": "piano-probe"},
            )
            seg = np.array(r["samples"][: int(0.30 * r["sampleRate"])], dtype=np.float64)
            fundamentals_piano[a] = hps_fundamental(seg, r["sampleRate"], fmin=120.0, fmax=1800.0)
        vals = [fundamentals_piano[a] for a in sorted(fundamentals_piano)]
        check.ok(
            "piano composicion: la fundamental de la 1a nota sube con la anomalia (HPS)",
            all(vals[i] >= vals[i - 1] for i in range(1, len(vals))) and vals[-1] > vals[0],
            str({k: round(v, 1) for k, v in fundamentals_piano.items()}),
        )

        # 9) Limite de compas (2.5 s): un cambio a 2.0 s no altera lo anterior
        #    a 2.5 s y si altera el compas siguiente.
        base = page.evaluate("async (p) => await window.AudioHarness.compositionMono(p)",
                             {"temperatureAnomalyK": 0, "renderSeconds": 5.2, "seed": "bar-probe"})
        chg = page.evaluate("async (p) => await window.AudioHarness.compositionMono(p)",
                            {"temperatureAnomalyK": 0, "renderSeconds": 5.2, "seed": "bar-probe",
                             "changeTemperatureAt": 2.0, "changeTemperatureTo": 9})
        sr2 = base["sampleRate"]
        b0 = np.array(base["samples"])
        c0 = np.array(chg["samples"])
        pre = slice(0, int(2.45 * sr2))
        post = slice(int(2.6 * sr2), int(4.9 * sr2))
        check.ok("limite de compas: antes de 2.5 s el audio es identico al control", float(np.max(np.abs(b0[pre] - c0[pre]))) < 1e-6)
        check.ok("limite de compas: despues de 2.5 s el audio cambia", float(np.max(np.abs(b0[post] - c0[post]))) > 1e-3)

        # 10) NULL corta de inmediato; todo NULL = silencio exacto; stop = silencio.
        allnull = page.evaluate("async (p) => await window.AudioHarness.compositionMono(p)", {"renderSeconds": 4.0})
        check.ok("composicion con todo NULL: silencio exacto (pico 0)", allnull["peak"] == 0.0, f"peak={allnull['peak']}")
        nl = page.evaluate("async (p) => await window.AudioHarness.compositionMono(p)",
                           {"temperatureAnomalyK": 4, "rainMmDay": 20, "iceFraction": 0.8, "renderSeconds": 4.0, "nullAtSec": 2.0})
        nsr = nl["sampleRate"]
        before = np.array(nl["samples"][int(1.0 * nsr): int(2.0 * nsr)])
        after = np.array(nl["samples"][int(2.3 * nsr):])
        rb = float(np.sqrt(np.mean(before ** 2)))
        ra = float(np.sqrt(np.mean(after ** 2)))
        check.ok("NULL en pleno compas: sonaba antes y calla de inmediato", rb > 0.005 and ra <= 1e-7, f"antes={rb:.4f} despues={ra:.2e}")
        st = page.evaluate("async (p) => await window.AudioHarness.compositionMono(p)",
                           {"temperatureAnomalyK": 4, "rainMmDay": 20, "iceFraction": 0.8, "renderSeconds": 5.0, "stopAtSec": 2.0})
        after_stop = np.array(st["samples"][int(2.3 * st["sampleRate"]):])
        check.ok("stop() de la composicion: silencio estricto despues de la rampa", float(np.max(np.abs(after_stop))) <= 1e-7,
                 f"peak={float(np.max(np.abs(after_stop))):.2e}")
        check.ok("stop() manual no dispara onEnd", st["ended"] is False)

        # 11) Ciclo de vida (regresion real, Tone.Offline): corte NULL/stop NO se
        #     reabre por setChannel con la misma config (rerender del panel).
        def life(actions, secs, use_clock=False):
            r = page.evaluate("async (p) => await window.AudioHarness.lifecycleScenario(p)", {"actions": actions, "renderSeconds": secs, "useClock": use_clock})
            return np.array(r["samples"], dtype=np.float64), r["sampleRate"], r["endedAt"]

        rer = [{"op": "rerender", "t": t} for t in (2.2, 2.5, 3.0, 3.6, 4.5)]
        ctrl, lsr, _ = life([], 6.0)
        win = slice(int(2.15 * lsr), int(6.0 * lsr))
        crms = float(np.sqrt(np.mean(ctrl[win] ** 2)))
        for name, first in (("NULL", {"op": "null", "t": 2.0}), ("stop", {"op": "stop", "t": 2.0})):
            sig, _, _ = life([first] + rer, 6.0, use_clock=(name == "stop"))
            rms_cut = float(np.sqrt(np.mean(sig[win] ** 2)))
            check.ok(
                f"ciclo de vida {name}->setChannel(misma config)+rerender: silencio tras rampa de 30 ms (<=1e-7) mientras el control continuo suena",
                crms > 0.001 and rms_cut <= 1e-7,
                f"control_rms={crms:.5f} cortado_rms={rms_cut:.2e}",
            )
        ctrl2, _, _ = life([], 24.0)
        fin_win = slice(int(20.6 * lsr), int(22.0 * lsr))
        sig2, _, ended = life([{"op": "stop", "t": 0.5, "afterEnd": True}] + [{"op": "rerender", "t": t, "afterEnd": True} for t in (0.8, 1.0, 1.5)], 24.0)
        c_tail = float(np.sqrt(np.mean(ctrl2[fin_win] ** 2)))
        s_tail = float(np.sqrt(np.mean(sig2[int(20.6 * lsr):] ** 2)))
        check.ok("fin natural: onEnd a 20 s y la cola del pad sigue acotada sin Stop (control > 0 a 20.6-22.0 s)", ended is not None and abs(ended - 20.0) <= 0.3 and c_tail > 1e-4, f"endedAt={ended} cola_rms={c_tail:.2e}")
        check.ok("fin natural->Stop->setChannel: silencio estricto tras la rampa (<=1e-7)", s_tail <= 1e-7, f"rms={s_tail:.2e}")
        late = float(np.sqrt(np.mean(ctrl2[int(23.0 * lsr):] ** 2)))
        check.ok("fin natural sin Stop: la cola termina sola (RMS 23-24 s < 1e-4)", late < 1e-4, f"rms={late:.2e}")

        check.ok("sin errores de pagina (pageerror) durante todo el harness", len(page_errors) == 0, str(page_errors))

        browser.close()

    return 0 if check.summary() else 1


if __name__ == "__main__":
    sys.exit(main())
