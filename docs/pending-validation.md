# Inventario de capacidades reales de verificacion — audio y accesibilidad (2026-10-09)

Tarea independiente de la investigacion de datos (ver
`docs/pending-data-research.md`). Esto es solo un **inventario verificado
por ejecucion real** de que se puede y que NO se puede probar en este
entorno, para que Codex decida que verificaciones agregar. **Correccion de
veracidad** (tarea09, sobre una afirmacion imprecisa de tarea08): esta
sesion SI ejecuto `pip install tifffile imagecodecs` (tarea08, libreria de
lectura de GeoTIFF) y mas tarde creo un entorno virtual propio del proyecto
en `work/pyenv/` (tarea09, `pip install numpy pyproj netCDF4 pytest
tifffile imagecodecs`, confinado a `work/pyenv/`, no global) para poder
ejecutar los scripts/pruebas de conversion de datos. Ninguna de esas
instalaciones es un lector de pantalla ni un motor de voz: no se instalo
ni reconfiguro NVDA, SAPI/OneCore ni ningun software de accesibilidad o
del sistema operativo. No se tocaron secretos ni se creo ningun test
falso. Modelo usado: `claude --model sonnet` (Sonnet 5, este agente).

## Lo que SI se verifico por ejecucion real en este entorno

### 1. Playwright + Chromium: instalado y funcional
```
py -3 -m pip show playwright   # version 1.58.0 (otro alias: 1.63.0)
py -3 -m playwright install --dry-run
```
Confirma binarios ya descargados en `~/AppData/Local/ms-playwright/`:
Chromium 1208/1234/1243/1248, Firefox 1509, WebKit 2248, Chrome Headless
Shell. No se descargo nada nuevo (`--dry-run`, y los directorios ya
existian antes de esta tarea).

### 2. Render de audio real con `OfflineAudioContext` (equivalente a `Tone.Offline`) + verificacion RMS
Se lanzo Chromium headless real via Playwright y se ejecuto JS real dentro
de la pagina (no un mock, no un numero inventado):

```python
osc = ctx.createOscillator(); osc.frequency.value = 440
osc.connect(ctx.destination); osc.start(0); osc.stop(1)
buf = await ctx.startRendering()
# RMS calculado sobre las 44100 muestras reales devueltas
```
Resultado real obtenido: `rms = 0.7071066058133084` para una senoidal de
amplitud 1 — coincide con el valor teorico exacto `1/sqrt(2) = 0.70710678`
(error ~1e-7, atribuible a la rampa de arranque/parada del oscilador, no a
simulacion). Esto confirma que **es posible** generar WAV/buffers reales
con `Tone.Offline` (que internamente usa `OfflineAudioContext`) dentro de
Playwright y verificar RMS/espectro (FFT) contra valores esperados — una
ruta de prueba real, no una afirmacion de "escucha humana".

**Propuesta concreta**: un test `tests/audio-*.offline.test.js` (Node, no
jsdom) que:
1. Lance Chromium headless con Playwright.
2. Cargue el `AudioEngine`/`mixer` real (o una pagina minima que los
   importe) dentro de un `OfflineAudioContext`.
3. Renderice N segundos para una combinacion de parametros conocida
   (ej. un dataset con anomalia fija).
4. Verifique: RMS distinto de 0 cuando debe sonar, RMS ~0 cuando esta
   muteado, y picos de frecuencia esperados via FFT (ej. `fft.js` o cálculo
   manual) si el mapeo dato→frecuencia es determinista.
Esto SI es verificable por maquina (numeros), a diferencia de "sonó bien".

### 3. `SpeechSynthesis`: API presente, 0 voces en Chromium headless (verificado, no supuesto)
```python
page.evaluate("() => ({has: !!window.speechSynthesis, voiceCount: window.speechSynthesis.getVoices().length})")
# -> {'has': True, 'voiceCount': 0}
```
Confirma por ejecucion real (no por lectura de documentacion) que el
Chromium headless de este entorno **no tiene ningun motor TTS del sistema
conectado** (comportamiento conocido de Chromium headless en Windows sin
`--enable-speech-dispatcher`/backend nativo). Esto es consistente con lo ya
anotado como pendiente en `docs/accessibility-review.md` ("voces reales no
verificadas"), ahora con evidencia de ejecucion en vez de solo advertencia.

**No se intento instalar ni registrar ninguna voz.**

### 4. NVDA: confirmado NO instalado, NO ejecutandose
```bash
ls "/c/Program Files (x86)/NVDA"   # No such file or directory
ls "/c/Program Files/NVDA"          # No such file or directory
```
No hay proceso `nvda.exe` corriendo. **No se instalo** (instruccion
explicita de no instalar/reconfigurar). Cualquier prueba con NVDA real
sigue pendiente de una sesion manual en una maquina con NVDA ya presente.

### 5. Voces SAPI/OneCore de Windows: verificacion bloqueada por permisos del entorno, no omitida por eleccion
Se intento leer (solo lectura, sin instalar nada) el registro de voces
instaladas:
```powershell
Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens"
```
El entorno de ejecucion rechazo el comando por politica de sandbox ("non-
filesystem provider path requires approval"), y la alternativa via
`System.Speech.Synthesis.SpeechSynthesizer` (.NET) tambien fue bloqueada
("Command compiles and loads .NET code"). Es decir: **no se pudo
enumerar las voces nativas de Windows en esta sesion**, no porque no se
intentara sino porque el sandbox de este agente no autoriza lectura de
registro ni compilacion de .NET sin aprobacion explicita del usuario. Si se
necesita ese dato, requiere que el usuario apruebe uno de esos dos comandos
puntualmente (son de solo lectura, no instalan ni cambian nada).

## Conclusion / propuesta

- **Factible ahora, sin pedir nada mas**: tests automatizados de audio
  reales (RMS/FFT) via Playwright + `OfflineAudioContext`/`Tone.Offline` en
  Chromium headless, verificando el pipeline `AudioEngine`/`mixer` con
  numeros, no con oido humano ni dispositivo fisico.
- **No factible en este entorno sin accion del usuario**: pruebas con NVDA
  real (no instalado, no se va a instalar sin pedirlo explicitamente),
  pruebas con voces de SpeechSynthesis reales (Chromium headless no trae
  ninguna), enumeracion de voces nativas de Windows (bloqueado por sandbox,
  se puede destrabar con aprobacion puntual de un comando de solo lectura).
- No se agrego ningun test nuevo todavia ni se modifico
  `tests/audio-engine.test.js`; esto es solo el inventario pedido. Si Codex
  aprueba, el siguiente paso seria escribir el test Playwright+Offline
  descrito en la seccion 2.
