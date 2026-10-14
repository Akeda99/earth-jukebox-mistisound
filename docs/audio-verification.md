# Verificacion de audio REAL (Tone.Offline + Python Playwright)

Objetivo: verificar numericamente (no "de oido") el pipeline de audio
REAL de produccion (`src/audio/engine.js` `AudioEngine`, `src/audio/mixer.js`
`DjMixer`) renderizando audio de verdad con `Tone.Offline`
(`OfflineAudioContext` real de Chromium), sin ningun mock de audio.

## Como ejecutar

```
npx vite --port 5181          # servidor dev (resuelve los imports ESM de src/ y 'tone')
py -3 scripts/verify_audio_offline.py --base-url http://127.0.0.1:5181
```

Usa **Python Playwright** (ya instalado en este entorno, Chromium real,
ver `docs/pending-validation.md`), **no** una dependencia nueva de Node
Playwright. El harness en si (`tests/browser/audio-harness.html` +
`tests/browser/audio-harness.js`) no es parte del bundle de produccion ni se
publica: solo importa los modulos reales de `src/` dentro de una pagina
minima para poder correrlos en Chromium.

Genera `outputs/earth-jukebox-demo.wav` (temperatura+lluvia+hielo
mezclados, 2 canales, 8s) con datos REALES de un punto/mes concreto (ver
seccion "Demo WAV" abajo) y reporta PASS/FAIL con valores reales medidos
para cada verificacion (ver salida del script).

## Hallazgo real: por que `Tone.getTransport()`/`Tone.getDestination()` NO sirven dentro de `Tone.Offline()`

`AudioEngine`/`DjMixer` usan `this.Tone.Transport` y `this.Tone.Destination`
(los exports **estaticos**, marcados `@deprecated` en el propio Tone.js,
ver `node_modules/tone/Tone/index.ts`): se calculan **una sola vez**,
cuando el modulo `tone` se evalua por primera vez, apuntando al contexto
de audio EN VIVO por defecto. En la app real (un unico `AudioContext` para
toda la pagina) esto es completamente correcto. Para renderizar estas
clases dentro de `Tone.Offline()` sin modificarlas, hace falta pasarles un
`ToneLib` cuyo `Transport`/`Destination` apunten al `OfflineAudioContext`
real que se esta grabando.

**Primer intento (fallido, pero instructivo):** una propiedad calculada
dinamicamente, `get Transport() { return Tone.getTransport(); }` —
exactamente el patron que el propio Tone.js recomienda como reemplazo del
export estatico. Funciona para el *setup* inicial (crear sintes, agendar
el primer pulso), pero **NO** para `stop()`/`clear()` llamados mas tarde
desde un callback que el propio Transport dispara *durante* el render.

Causa raiz (confirmada leyendo
`node_modules/tone/Tone/core/context/Offline.ts`):

```ts
export async function Offline(callback, duration, channels=2, sampleRate=...) {
  const originalContext = getContext();
  const context = new OfflineContext(channels, duration, sampleRate);
  setContext(context);
  await callback(context);            // el callback se ejecuta AQUI (contexto offline activo)
  const bufferPromise = context.render();  // el render empieza aqui...
  setContext(originalContext);        // ...pero el contexto global YA se restaura AQUI, antes de que el render termine
  const buffer = await bufferPromise;
  return new ToneAudioBuffer(buffer);
}
```

`setContext(originalContext)` se ejecuta **inmediatamente despues** de
invocar `context.render()`, sin esperar a que termine. El render en si
sigue en curso de forma asincrona. Cualquier callback de Transport
(`scheduleOnce`/`scheduleRepeat`) que se dispare **durante esa fase
tardia del render**, si llama a `Tone.getTransport()` en ese instante,
obtiene el Transport del contexto **EN VIVO ORIGINAL** (ya restaurado),
no el del contexto offline que todavia se esta grabando.
`Transport.clear(id)`/`.stop()` invocados sobre ese Transport equivocado
no tienen ningun efecto sobre el render real: los eventos "fantasma"
siguen sonando indefinidamente dentro del buffer offline, aunque el
codigo de produccion (`DjMixer.stop()`) se ejecute "correctamente" sobre
el objeto incorrecto.

Se reprodujo en un caso minimo, sin ninguna clase de produccion de por
medio (solo `Tone.getTransport().scheduleRepeat(...)` + `clear()` +
`stop()`), confirmando que es un comportamiento de Tone.js/`Offline()`, no
un bug introducido por `AudioEngine`/`DjMixer`.

**Correccion real** (sin tocar ningun archivo de `src/`): el propio
callback que `Tone.Offline()` invoca recibe como parametro el
`OfflineContext` (`context.transport`, `context.destination`, ver
`Context.ts`). Capturando esas referencias **una sola vez**, de forma
sincrona, dentro del callback (antes de que exista cualquier
`await`/callback futuro), y usandolas como propiedades de **datos**
normales (no getters) del `ToneLib` que se pasa a `AudioEngine`/`DjMixer`,
el resto del pipeline (que nunca vuelve a pedir `this.Tone.Transport` "de
nuevo" dinamicamente, solo reutiliza la misma referencia) funciona sin
ninguna modificacion de produccion:

```js
await Tone.Offline((offlineContext) => {
  const ToneLib = {
    ...Tone,
    Transport: offlineContext.transport,     // capturado UNA vez, nunca getter
    Destination: offlineContext.destination
  };
  const engine = new AudioEngine({ ToneLib });
  // ...
}, duration);
```

Esto **no es un mock**: los nodos/sintetizadores/limiter/Transport siguen
siendo instancias reales de Tone.js, conectadas al `OfflineAudioContext`
real. Es, literalmente, el mismo patron documentado en los ejemplos
oficiales de `Tone.Offline(({ transport }) => ...)` (usar el `transport`
del parametro del callback), aplicado a traves de la inyeccion de
dependencias que `AudioEngine`/`DjMixer` ya aceptaban (`ToneLib`).

## `Tone.start()` en contexto offline

`AudioEngine.start()` llama a `this.Tone.start()` (el export **dinamico**),
que internamente hace `globalContext.resume()`. Dentro del callback de
`Tone.Offline()`, el contexto global YA es el offline en ese momento, asi
que esta llamada resuelve sobre el contexto correcto sin ninguna
adaptacion adicional. Lo mismo aplica a `dbToGain`/clases de nodos
(`Gain`, `Synth`, `NoiseSynth`, `Limiter`): no dependen del contexto
activo en el momento de construirse (leen `getContext()` solo una vez, al
crearse, y eso SI ocurre durante la fase sincrona del callback, antes de
que Offline() restaure el contexto original).

## SEGUNDO HALLAZGO REAL (corregido en revision posterior): `now`/`Time` dinamicos TAMBIEN fallan dentro de callbacks tardios

La primera version de este documento afirmaba, de forma **incorrecta**,
que `this.Tone.now()` y `this.Tone.Time(...)` no necesitaban ninguna
adaptacion por ser "dinamicos". Eso es cierto solo mientras se llaman
*durante la fase sincrona* del callback de `Tone.Offline()` (p.ej. al
construir los nodos). Pero `DjMixer._onPulse` llama
`this.Tone.Time('4n').toSeconds()` en **cada pulso**, y `DjMixer.stop()`/
`AudioEngine.setMuted()` llaman `this.Tone.now()` desde dentro de
callbacks que el propio `Transport` dispara **durante la fase tardia del
render** (exactamente el mismo momento descrito arriba para
`Transport`/`Destination`, en el que `setContext(originalContext)` ya se
ejecuto). En ese instante, `Tone.now()`/`Tone.Time(...)` (que hacen
`getContext().now()` / construyen un `TimeClass` ligado a `getContext()`
en el momento de la llamada) devuelven el reloj/Transport del contexto EN
VIVO original, no el offline.

**Efecto real medido antes de la correccion**: con un `DjMixer` a BPM 72
en un render offline, los intervalos entre subdivisiones de lluvia
(calculados a partir de `Time('4n').toSeconds()`) correspondian al BPM
**120 por defecto** del Transport en vivo, no a 72 — un factor de error de
~1.67x en la escala temporal de la lluvia. Y el test de mute previo
resulto ser un **falso positivo**: usaba `AudioEngine.playAnomaly()` suelto
(sin ningun `Transport.start()` en ningun lado) con
`Transport.scheduleOnce(mute, 0.3)` — como el Transport nunca arrancaba,
ese callback **nunca se ejecutaba**, y la "ventana muteada" medida en
realidad solo capturaba el final natural (release) de una nota ya
terminada, no un mute real.

**Correccion** (igual patron que `Transport`/`Destination`: usar el
`offlineContext` ya capturado, nunca la funcion dinamica global):

```js
function makeOfflineToneLib(offlineContext) {
  return {
    ...Tone,
    Transport: offlineContext.transport,
    Destination: offlineContext.destination,
    now: () => offlineContext.now(),
    Time: (value, units) => new Tone.TimeClass(offlineContext, value, units)
  };
}
```

`TimeClass(context, value, units)` es la firma real confirmada en
`node_modules/tone/Tone/core/type/TimeBase.ts` linea 78. Sigue sin ser un
mock: `TimeClass` es la clase real de Tone.js.

**Correccion del test de mute**: ahora usa un `DjMixer` CONTINUO (no una
nota suelta) con `mixer.start()` (que SI llama `Transport.start()` de
verdad), y verifica explicitamente: (a) el callback de
`Transport.scheduleOnce` efectivamente se ejecuto (`muteCallbackFired`),
(b) `engine.isMuted()` es `true` despues, (c) la MISMA escena SIN mutear
(control) SI produce RMS audible en la misma ventana temporal (para
confirmar que "hubiera sonado" si no se muteara), y (d) con mute real, el
RMS/pico tras la rampa son `<= 1e-7` (epsilon estricto, no una tolerancia
floja).

## Que verifica el script (`scripts/verify_audio_offline.py`)

| Verificacion | Metodo | Tolerancia |
|---|---|---|
| `Tone.Offline` renderiza audio real | RMS de una senoidal 440Hz contra el valor teorico exacto | `< 1e-3` |
| Temperatura (mapeo musical v2): nota exacta para -12, -5, -2, 0, 2, 5, 6, 9, 12 K | **FFT independiente (`numpy.fft.rfft`)** y **producto armonico espectral (HPS)** sobre la forma de onda cruda de `engine.playAnomaly` (el HPS evita confundir un armonico fuerte con la fundamental); Hz esperado recalculado independientemente (asinh, rango -12..12, 20 notas, 12-TET A4=440) | `<= max(3×resolucion_fft, 1% Hz esperado)`; monotonia; 6 K y 9 K suenan distinto; -2 < 0 < 2 |
| Mute real corta a silencio exacto tras la rampa | `DjMixer` CONTINUO con `Transport.start()` real; se verifica que el callback de mute se ejecuto, `isMuted()===true`, un control sin mutear SI suena en la misma ventana, y RMS/pico tras la rampa | `<= 1e-7` (epsilon estricto) |
| Hielo: "fade" continuo con la fraccion, 0.0 real = silencio real | RMS **estrictamente** creciente con la fraccion (.25<.5<.75<1); fraccion 0 | `< 1e-4` para fraccion 0 |
| Lluvia: mas mm/day = mas "hits" | Conteo de onsets (ventanas de 10ms con salto de energia) | monotonia no estricta + reproducibilidad exacta con la misma semilla |
| Lluvia: intervalo real escala con BPM (48/72/96) | Tiempos de onset reales (ventanas de 5 ms). A densidad 1 se disparan 4 subdivisiones por pulso: intervalo fundamental esperado = `60/bpm/4` (0.3125 / 0.2083 / 0.1562 s). Se usa la mediana de intervalos / k (k<=2 si el detector pierde un golpe) y se exige que >=70% de los intervalos coincidan; ademas ratio 48/96 ~ 2 | `max(6 ms, 8%)`; medido: 0.310 / 0.210 / 0.155 s, 35/35, 36/36 y 38/38 intervalos coinciden |
| Control negativo de tempo | Mismo render a BPM 48 con un Transport que IGNORA el BPM configurado (queda en 120; `makeBrokenTimeToneLib` en el harness). Desde la version musical 2 el mezclador ya no usa `Tone.Time()`, asi que el bug original de `Time` no se puede reproducir; el control reproduce su efecto | la metrica DEBE fallar: mediana 0.125 s (= 60/120/4), 0/87 intervalos coinciden con 0.3125 s |
| `stop()` no deja un loop fantasma | Cero onsets nuevos bien despues de la cola de release de la ultima nota ya disparada | `onsets == 0`, RMS `< 0.001` |
| Composicion de 20 s (WAV demo) | `DjMixer.start({mode:'composition'})` real, 128 pasos a 96 BPM, 22.5 s renderizados: `onEnd` dispara a 20.003 s (±0.3), 2 canales, finito, pico `< 0.9` (medido 0.0676), RMS > 0.005 (0.0091), cola 22.0-22.5 s `< 1e-3`, energia en 0-10 s y 10-20 s | ver script |
| Piano de la composicion | Fundamental (HPS) de la 1a nota para -8, -2, 0, 2, 6, 9 K | crece con la anomalia |
| Evolucion en limite de compas | Cambio de dato a 2.0 s (compas = 2.5 s): audio identico al control antes de 2.45 s; distinto despues de 2.6 s | `< 1e-6` / `> 1e-3` |
| NULL / stop | Todo NULL: pico exactamente 0. NULL a 2.0 s en plena mezcla: RMS antes > 0.005 y despues `<= 1e-7`. `stop()` a 2.0 s: pico `<= 1e-7` y sin `onEnd` | epsilon estricto |

No se exige igualdad de bytes contra un render anterior del ruido de
lluvia (`NoiseSynth` es no determinista en su forma de onda interna): lo
que es reproducible, y lo que se verifica, es el **patron ritmico**
(numero de hits, intervalos) para una semilla+dato fijos, que depende del
PRNG `mulberry32` propio del mezclador, no del generador de ruido de
Tone.js.

## Demo WAV: un punto/mes real, derivado de archivos

`outputs/earth-jukebox-demo.wav` usa datos REALES de un unico punto/mes
(**Artico, 75.19N/-133.67W, diciembre 2023**, celda de rejilla 75N/-133W).
Los parametros NO estan escritos a mano: `load_demo_params()` en
`scripts/verify_audio_offline.py` los lee y valida (periodo, celda mas
cercana en `axes.lat_centers/lon_centers`, cobertura > 0, unidad, punto y
SHA256 del sidecar); si algo no coincide, el demo no se genera.

| Canal | Valor | Fuente | Evidencia |
|---|---|---|---|
| Hielo | fraccion 0.9861, cobertura 21 px de 25km | `public/data/sea-ice-g02135/2023-12.json` (NOAA/NSIDC G02135) | `version_hash` del JSON (`9c3098cb...e35`) |
| Lluvia | 0.33 mm/day (PRECTOTCORR 202312, MERRA-2) | **snapshot publico** `tests/fixtures/demo-point-evidence/power_75.19_-133.67_2023.json` (683 bytes, incluible en el ZIP; `work/` NO se incluye) | sidecar `power_75.19_-133.67_2023.meta.json`: URL oficial, fecha de captura 2026-10-10 (mtime local), SHA256 `37ef255e...99a6`, unidad mm/day, punto |
| Temperatura | anomalia 7.82 K | `public/data/gistemp/2023-12.json` (GISTEMP), misma celda | `source.original_file_sha256` (`6a597332...fe0cc6`) |

Correccion: el JSON crudo de POWER (683 bytes) NO contiene la URL ni un
SHA; esos datos viven solo en el sidecar (la URL es la reconstruida con
los mismos parametros que arma `src/data/power-repository.js`). El
snapshot sirve unicamente para reproducir el demo sin llamar a la API en
cada prueba de audio; la **app en vivo** sigue consultando POWER en tiempo
real y no usa este archivo.

Decision musical documentada (version musical 2): el rango musical fijo es
-12..+12 K con compresion asinh, asi que 7.82 K **no satura**: cae en el
registro 15 de 16.
El rango -5..+5 K sigue siendo solo el rango de COLOR de la leyenda. 0.33
mm/day es realmente bajo (pocas gotas, no ninguna). Semilla fija:
`demo-wav-2023-12-arctic` (`compositionMix` en `tests/browser/audio-harness.js`).
El WAV dura 22.5 s: 20.0 s de composicion mas la cola natural de release
del ultimo acorde. Es una mezcla suave (pico 0.0676, RMS 0.0091): no esta
normalizada, para no inflar artificialmente el nivel del bus real.

## Limitaciones explicitas (no se inventa evidencia)

- No hay verificacion de "escucha humana"; todo lo anterior es numerico.
- El audio nunca se reproduce automaticamente al cargar ninguna pagina de
  la app (ni este harness): `Tone.Offline()` nunca toca los altavoces.
- NASA POWER no publica un `data_version`/snapshot congelado para
  consultas en vivo (a diferencia de los 3 puntos locales de Peru, que SI
  tienen `data_version` fijo): el valor 0.33 mm/day documentado aqui es el
  que la API devolvio el dia de esta verificacion; una consulta repetida
  mas adelante podria traer un valor revisado. Esto no es un bug de la
  app, es una limitacion real de la fuente (ver `docs/power-data.md`).
- La composicion de 20 s usa sintesis FM/membrana de Tone.js; no es un piano
  acustico real ni se afirma que "suene bonito": solo se verifica
  numericamente (fundamentales, tiempos, silencios, finitud).
- Evidencia de rendimiento del globo (`requestRenderMode`) en
  `work/render-load-run14.txt`. Los fallos TargetClosed (93/96) de la
  auditoria anterior no se convierten en PASS: la ultima corrida completa de
  `verify_accessibility.py` dio 97/97, pero eso es una corrida nueva, no una
  reinterpretacion de las anteriores.

## Ciclo de vida de cortes (tarea 14b)

`lifecycleScenario` (harness) ejecuta el mezclador de produccion con solo el
pad (hielo=1) en modo composicion. Control sin acciones: RMS 0.00908. Con
acciones, la ventana medida empieza 150 ms despues del corte (rampa de 30 ms
+ margen) y el umbral es 1e-7 solo si el control suena (>0.001):

| Escenario | Resultado |
|---|---|
| NULL a 2.0 s + `setChannel` misma config a 2.2/2.5/3.0/3.6/4.5 s | RMS 0 |
| `stop()` a 2.0 s + mismos rerenders (reloj del contexto, el Transport ya esta parado) | RMS 0 |
| Fin natural (onEnd 20.003 s) -> Stop 0.5 s despues -> setChannel | RMS 0 |
| Fin natural sin Stop | cola RMS 4.3e-4 (20.6-22.0 s), 0 desde 23 s |

Total `verify_audio_offline.py`: 71/71. Mutacion de control: quitando el latch
fallan 3 de estas pruebas.
