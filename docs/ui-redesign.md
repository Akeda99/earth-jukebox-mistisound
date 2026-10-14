# Rediseño de interfaz (Earth Jukebox)

Cambio visual y de maquetación acotado. No se tocó la ciencia, el motor de audio, la composición, el mezclador, el esquema de presets, el coordinador, la semántica de cancelación de historia/ciudades ni los JSON de datos. Las maquetas aprobadas (`ideas-ui/01..03`) son solo referencia: la página usa el globo Cesium real y overlays numéricos reales, sin datos, ondas ni insignias inventadas.

## Dirección

- **Una sola paleta para los cinco modos**: marfil + verde bosque (tokens en `:root`, `color-scheme: light`), titular serif (Georgia del sistema). No hay paletas por modo ni modo oscuro. Cabecera, barra de audio, panel, formularios, botones, linea de tiempo y estados deshabilitados/foco comparten los mismos tokens.
- **Un solo atributo de modo**: `html[data-mode]` (`history | explore | peru | accessible | dj`), escrito por `src/ui/tabs.js` desde el estado. Solo condiciona la geometria/maquetacion (reparto globo/panel), nunca colores.
- Canales DJ: acentos semanticos pequenos (coral temperatura, azul lluvia, verde azulado hielo) definidos en `:root` como tonos oscuros (>=5.8:1 sobre marfil como texto, texto blanco sobre el relleno al activarse). Fuego usa el color de control neutro.
- Los colores de datos del globo y de la leyenda de temperatura (significado cientifico) no cambian.
- Sin fuentes remotas, sin Tailwind/React/paquetes nuevos.
- Cabecera común: marca con barras de onda decorativa en SVG (`aria-hidden`), cinco pestañas (la activa con píldora), ES/EN. En móvil: marca + ES/EN en una fila, pestañas en la siguiente.
- Barra de audio persistente y pegajosa: Activar/Detener, botón Silenciar con texto visible, volumen con valor en dB.
- Reparto en escritorio (>860px, vía CSS `order`/`flex-basis`; el orden DOM no cambia):
  - Historia/Accesible: panel ~55 % izquierda, globo ~45 % derecha.
  - Explorar/Perú: globo ~68 %, panel de datos a la derecha.
  - DJ: globo ~45 % izquierda, panel ~55 %.
- En móvil el globo va primero (34vh Historia/Accesible, 46vh resto) y el panel se apila debajo.
- `src/main.js`: un `ResizeObserver` sobre `#globe-container` llama a `viewer.resize()` y `scene.requestRender()` (rAF). Es solo presentación; se mantienen `requestRenderMode` y los marcadores solo de Perú, sin animación continua.

## UX cambiada

- **Historia**: titular «La Tierra también tiene tu historia» / «Earth has your story too»; formulario compacto (grupo lugar + par mes/año en dos columnas desde 560px de panel); tras enviar, dos tarjetas Antes/Después (mes, anomalía firmada real) con los botones reales de escucha dentro, y la diferencia con la referencia común (`promedio 1951–1980`). Las tarjetas son `aria-hidden`; el resumen en texto plano y el comportamiento de lector de pantalla existentes se conservan (sin anuncios duplicados). Avisos de región/sin tendencia/sin «hoy»/privacidad siguen visibles.
- **Explorar**: valor de anomalía, unidades y periodo destacados; detalles secundarios (celda, resolución, suavizado) en `<details class="point-more">` nativo; leyenda propia y EIC al final. La leyenda de temperatura no cambió.
- **DJ** (superficies claras, sin grafito ni CTA ambar): transporte compacto (Reproducir, Escuchar composición, semilla, BPM) encima de tres tiras alineadas (subgrid) con subtítulo de instrumento, Activar/Solo, ganancia con valor en dB. Fuego sigue deshabilitado y lo dice (`Canal reservado`). Las reglas van en `<details>` nativo. En laptop de 720px el panel desplaza; las ganancias quedan bajo el pliegue hasta desplazar el panel.
- Al cambiar de pestaña el panel lateral vuelve arriba.
- Nuevas claves i18n (ES/EN en paridad): `muteVisibleLabel`, `historyCardBefore/After/Baseline/Delta`, `pointMoreSummary`, `djCaption*`, `djRulesSummary`. `compositionTitle` quedó sin uso.

## Comprobaciones exactas (servidor Vite propio en :5183)

| Comprobación | Resultado |
|---|---|
| `npm test` | 254/254, salida 0 |
| `npm run build` | salida 0 |
| `py -3 scripts/verify_history.py --base-url http://127.0.0.1:5183` | 100/100, salida 0 (Iquitos 1990-01 = +0.18, 2026-08 = +2.97, diferencia +2.79; editar fecha o línea de tiempo invalida el resultado; Enter/Espacio en `details`; ES/EN; axe sin violaciones con contraste) |
| `py -3 scripts/verify_accessibility.py --base-url http://127.0.0.1:5183` | 105/105, salida 0 (5 pestañas × ES/EN × escritorio y móvil, axe con contraste, Activar/silenciar/volumen/DJ reproducir/Detener) |
| `py -3 scripts/verify_composition_keyboard.py --base-url http://127.0.0.1:5183` | 6/6, salida 0 |
| Desbordamiento horizontal 360/375/768/1280/1440 × ES/EN × 5 pestañas (`work/ui_overflow.py`) | 0 casos con desbordamiento |
| Paleta unificada (`work/ui_unified_check.py`): colores computados de body, cabecera, barra de audio, panel, linea de tiempo, pestaña activa y boton de audio identicos en las 5 pestañas; sin desbordamiento a 360 y 1280 | OK. `npm run build` salida 0; `verify_accessibility.py` 105/105 salida 0 |

Capturas (carpeta `work/`; tema unificado: `ui-unified-explore-*.png`, `ui-unified-dj-*.png`): `ui-before-*` y `ui-after-*` de Historia (formulario y resultado), Explorar y DJ a 1280x720 y 360x800 (`work/ui_shots.py`).

## Límites restantes

- No hubo escucha humana de audio, ni NVDA/VoiceOver, ni teléfono físico: solo Chromium (Playwright) y axe.
- El orden visual del globo (a la derecha o izquierda según modo) se logra con CSS; el orden de tabulación/lectura sigue el DOM.
- En 1280x720 los controles de ganancia de DJ requieren desplazar el panel.
- No existe `AGENTS.md` en el proyecto.
