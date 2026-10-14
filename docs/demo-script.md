# Guion de demo (~3 min)

Asume `npm run dev` corriendo y navegador abierto en la URL local que
imprime Vite. Este guion es local: abrir ese enlace desde OTRO dispositivo
de la misma red NO funciona salvo que la app este publicada/desplegada
(`npm run build` + hosting); eso tambien se avisa en la UI (`shareLocalNote`
junto al enlace de "Compartir").

1. **(0:00-0:25) Explorar** — Click en el globo sobre cualquier punto.
   Panel derecho muestra coordenadas, celda GISTEMP, periodo, anomalia,
   unidad, linea base. Click en "Activar sonido" (barra superior, SIEMPRE
   visible) y luego "Escuchar punto": una nota pentatonica suena segun la
   anomalia.
2. **(0:25-0:45) Linea de tiempo** — Cambiar ano/mes con los selects del
   pie. El overlay numerico y el panel se actualizan; "Reproducir" avanza
   automaticamente SIN sonar (no autoplay) salvo que el audio ya este
   activo, en cuyo caso cada periodo confirmado SI actualiza la musica
   (accion explicita del usuario al pulsar Reproducir).
3. **(0:45-1:10) Peru** — Pestana "Peru": elegir Iquitos/Quelccaya/Mar
   frente a Piura, leer su historia, "Escuchar historia" (voz opt-in) y ver
   la anomalia GISTEMP de la celda mas cercana.
4. **(1:10-1:40) Accesible (teclado)** — Pestana "Accesible": Tab hasta
   latitud/longitud, escribir -3.75 / -73.25 (Iquitos), elegir periodo
   2023-01, Enter. El resultado (`aria-live`) muestra el dato SIN pulsar
   nada mas; year/month/range del pie TAMBIEN quedan en 2023-01 (fallo de
   sincronizacion corregido en esta entrega). Activar "Voz de navegacion"
   y repetir una consulta: se anuncia por voz con un debounce corto.
5. **(1:40-2:20) DJ** — Pestana "DJ": con audio ya activo, seleccionar un
   punto de Peru (lluvia local, sin red) o cualquier otro punto del globo
   (consulta en vivo a NASA POWER, se muestra "cargando..." y luego fuente/
   unidades/anio). Activar canal "Lluvia", ajustar ganancia, "Reproducir
   mezcla": temperatura (pentatonica) y lluvia (densidad ritmica) suenan
   sobre el mismo pulso. Cambiar de punto: la lluvia anterior NO sigue
   sonando. Incendios/hielo aparecen deshabilitados con el aviso de
   autenticacion NASA pendiente.
6. **(2:20-2:45) Recursos EIC** — En "Explorar", abrir el desplegable
   "Recursos EIC": mapa anual NASA SVS 2025 + "Escuchar indicador global"
   (sonifica +1.19 °C, el promedio GLOBAL ANUAL, no la celda local).
7. **(2:45-3:00) Compartir** — "Guardar y generar enlace": copia la URL con
   el preset (punto/periodo/idioma/canales DJ/semilla, nunca volumen
   maestro/mute). Pegar esa misma URL en una pestana nueva: aplica el
   preset sin activar audio automaticamente.

## Que SI se probo realmente

`npm test` (120 pruebas), `npm run build`, y un smoke test real en
Chromium headless (Playwright, viewport 360x800) que cubre los pasos 1, 4 y
6 de este guion punto por punto (10/10 verificaciones OK) — ver
`docs/acceptance.md` para el detalle exacto de cada verificacion.

## Que queda pendiente

Ejecutar este guion con un navegador real con interaccion humana
(incluyendo audio audible, lector de pantalla real y
`prefers-reduced-motion`) — ver limitaciones en `docs/acceptance.md`.

## Recorrido de 3 minutos: Tu historia con la Tierra

1. **(0:00-0:20)** La app abre en "Tu historia". Leer la nota del ultimo mes
   real (agosto de 2026) y la advertencia de que son observaciones mensuales.
2. **(0:20-0:50)** Escribir "Iquitos" y pulsar Buscar; elegir "Iquitos, Peru".
   Elegir mes "Enero" y escribir 1990 (es una fecha de ejemplo, no del publico).
   Pulsar "Ver mi historia".
3. **(0:50-1:20)** Leer el relato: anomalia en enero de 1990, anomalia en
   agosto de 2026, diferencia en °C. Senalar la tabla y las preguntas guia.
4. **(1:20-1:45)** Pulsar "Activar sonido" arriba. "Escuchar antes" y luego
   "Escuchar despues": misma frase, mismo tempo y volumen; solo cambian las
   notas. Mostrar que Detener, silencio y volumen siguen visibles.
5. **(1:45-2:20)** Marcar "Anunciar cada epoca con voz" y pulsar "Comparar
   automaticamente". Detener con el boton.
6. **(2:20-2:40)** Cambiar a EN y volver a ES; probar una fecha futura para ver
   el error accesible. Con un mes sin dato mostrar "Sin dato" (no se inventa
   musica).
7. **(2:40-3:00)** "Guardar y generar enlace" y abrirlo: restaura la historia
   sin sonar. Recordar que el enlace no guarda nombre ni dia.
