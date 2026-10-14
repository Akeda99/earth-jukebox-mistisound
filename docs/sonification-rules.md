# Reglas de sonificacion (version musical 2)

Todo el sonido sale de Tone.js (sin Suno, ElevenLabs, muestras externas ni
backend) y pasa por el unico bus global (limiter + volumen + mute).

## Composicion de 20 s

8 compases 4/4 a 96 BPM = 128 semicorcheas = 20.0 s. Secuencia de compases
A A B C A A B FIN. Motivo C-D-E-G-A (pentatonica). Nunca autoplay: solo el
boton "Escuchar composicion". Al terminar llama a `onEnd` y se detiene sola.

| Dato | Instrumento | Regla |
|---|---|---|
| Anomalia de temperatura (K) | Piano suave (FM, no es piano acustico) | Sube/baja el REGISTRO (16 pasos) del mismo motivo |
| Lluvia (mm/dia, 0..20) | Gotas (membrana corta) | Mas lluvia solo AGREGA gotas sobre el pulso (conjuntos anidados); el tempo no cambia |
| Fraccion de hielo (0..1) | Pad cristalino (acorde por compas) | Volumen proporcional a la fraccion |
| Incendios | -- | Deshabilitado (sin datos) |

NULL = ese instrumento no suena. 0 es distinto de NULL: lluvia 0 = cero
gotas; hielo 0 real = silencio (bajo el umbral de deteccion de G02135). Un
valor no finito se trata como NULL.

## Mapeo de temperatura (`src/audio/mapping.js`)

Rango musical FIJO, igual para todos los puntos y periodos:
`MUSIC_ANOMALY_RANGE = [-12, +12] K`, compresion asinh:

    unit = asinh(clamp(v, -12, 12) / 2) / asinh(6)        // en [-1, 1]
    paso = round(((unit + 1) / 2) * (pasos - 1))          // 16 registros (composicion), 20 notas (nota suelta)

Es monotono (mas anomalia nunca baja la nota). Referencias: -2 < 0 < 2 K
suenan distinto; 6 K y 9 K suenan distinto; 7.82 K (demo) = registro 15 de
16 y NO satura. Solo por encima de +-12 K se satura, y la UI lo avisa
(el valor mostrado sigue siendo el real). Con 16 registros, valores muy
cercanos pueden sonar igual: la UI lo dice y muestra el valor real.

**Rango de color vs. rango musical**: la leyenda/overlay usa -5..+5 K
(`ANOMALY_RANGE`) solo para el COLOR; no afecta al sonido.

## Evolucion en el tiempo

Los datos nuevos se aplican en el siguiente limite de compas (un solo
pendiente por canal, gana el ultimo). Excepcion: NULL calla el instrumento al
instante (rampa de 30 ms). Determinismo: PRNG sin estado (`hash01`) a partir
de semilla + paso; la misma semilla y datos dan la misma pieza.

## Preset compartido

v3 anade `music: {v: 2, style: "piano-drops-ice", motif: "CDEGA", dur: 20}`.
Un enlace v2 abre con aviso (la musica actual puede sonar distinta) y sin
autoplay. Un `music.v` desconocido o una version de preset desconocida se
rechazan con error explicito. Limite de 2000 caracteres.
