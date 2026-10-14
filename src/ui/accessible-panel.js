import { t } from '../i18n/index.js';

/**
 * Valida latitud/longitud estrictamente (numero finito dentro de rango).
 * NUNCA satura un valor fuera de rango al limite mas cercano: un valor
 * invalido se rechaza explicitamente (la UI debe mostrar un error y no
 * enviar la consulta), porque en un formulario accesible un "silencioso
 * reemplazo" del valor que el usuario escribio seria confuso/enganoso.
 */
export function validateLatLon(lat, lon) {
  const errors = [];
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.push('lat');
  }
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    errors.push('lon');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Construye la descripcion textual completa del estado actual (ubicacion,
 * periodo, anomalia, unidad, linea base, nota de significado, y estado de
 * audio). Pura funcion de datos -> texto, sin tocar el DOM, para poder
 * probarla sin entorno de navegador.
 *
 * Distingue explicitamente tres casos que NUNCA deben confundirse:
 *  - cell.value === null: sin dato original en esa celda/periodo.
 *  - cell.value === 0: dato real, anomalia nula (sin desvio respecto a la
 *    linea base), que es un numero valido y se muestra como tal.
 *  - audio muteado: silencio elegido por el usuario, no relacionado con si
 *    hay o no dato.
 */
export function describeState({ lang, selectedPoint, cell, dataset, audio }) {
  const lines = [];
  if (!selectedPoint) {
    lines.push(t(lang, 'accessibleNoSelection'));
    return lines.join(' ');
  }

  lines.push(
    t(lang, 'accessibleLocationLine', { lat: selectedPoint.lat.toFixed(2), lon: selectedPoint.lon.toFixed(2) })
  );

  if (dataset) {
    lines.push(t(lang, 'accessiblePeriodLine', { period: dataset.period }));
  }

  if (cell) {
    if (cell.value === null || cell.value === undefined) {
      lines.push(t(lang, 'accessibleValueMissingLine'));
    } else {
      lines.push(
        t(lang, 'accessibleValueLine', {
          value: `${cell.value >= 0 ? '+' : ''}${cell.value.toFixed(2)}`,
          units: dataset?.units ?? ''
        })
      );
    }
  } else {
    lines.push(t(lang, 'accessibleNoCell'));
  }

  if (dataset) {
    lines.push(t(lang, 'accessibleBaselineLine', { baseline: dataset.baseline_period }));
    lines.push(t(lang, 'accessibleMeaningNote'));
  }

  if (audio) {
    if (audio.muted) {
      lines.push(t(lang, 'accessibleAudioMutedLine'));
    } else if (audio.started) {
      lines.push(t(lang, 'accessibleAudioOnLine'));
    } else {
      lines.push(t(lang, 'accessibleAudioOffLine'));
    }
  }

  return lines.join(' ');
}

/**
 * Panel "Accesible": ruta HTML completa (lat/lon validados, periodo,
 * variable fija por ahora a GISTEMP, Consultar/Escuchar/Describir/A-B/
 * lugares) que NUNCA depende del canvas de Cesium ni de que el globo haya
 * inicializado: todas las acciones son botones/inputs/selects nativos.
 */
export function createAccessiblePanel({
  store,
  repository,
  narrator,
  onQuery,
  onDescribe,
  onListen,
  onCompareA,
  onCompareB
}) {
  const form = document.getElementById('accessible-form');
  const latInput = document.getElementById('acc-lat');
  const lonInput = document.getElementById('acc-lon');
  const periodSelect = document.getElementById('acc-period');
  const errorEl = document.getElementById('acc-form-error');
  const descriptionEl = document.getElementById('acc-description');
  const listenBtn = document.getElementById('acc-listen-btn');
  const describeBtn = document.getElementById('acc-describe-btn');
  const compareABtn = document.getElementById('acc-compare-a-btn');
  const compareBBtn = document.getElementById('acc-compare-b-btn');
  const compareResultEl = document.getElementById('acc-compare-result');
  const placesList = document.getElementById('acc-places-list');
  const narrationAutoCheckbox = document.getElementById('acc-narration-auto');

  if (periodSelect) {
    periodSelect.innerHTML = '';
    const periods = repository?.availablePeriods ?? [];
    for (const period of periods) {
      const opt = document.createElement('option');
      opt.value = period;
      opt.textContent = period;
      periodSelect.appendChild(opt);
    }
    // Por defecto, el mas reciente disponible (no el primero del manifiesto):
    // sin esto, "Consultar" sin tocar el periodo saltaria silenciosamente al
    // periodo mas antiguo en vez de mantener el actualmente activo.
    if (periods.length > 0) periodSelect.value = periods[periods.length - 1];
  }

  function showError(key) {
    if (!errorEl) return;
    errorEl.textContent = key ? t(store.get().lang, key) : '';
  }

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    // Un input vacio NUNCA se trata como 0: Number('') es 0 (finito, en
    // rango), lo que aceptaria en silencio una consulta sin coordenadas.
    // Se rechaza explicitamente antes de convertir, sin depender de
    // "required"/novalidate del formulario.
    const latRaw = latInput?.value ?? '';
    const lonRaw = lonInput?.value ?? '';
    if (latRaw.trim() === '' || lonRaw.trim() === '') {
      showError('accessibleInvalidCoords');
      return;
    }
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    const { valid } = validateLatLon(lat, lon);
    if (!valid) {
      showError('accessibleInvalidCoords');
      return;
    }
    showError(null);
    const period = periodSelect?.value || undefined;
    onQuery?.({ lat, lon, period });
  });

  listenBtn?.addEventListener('click', () => onListen?.());

  // "Describir" es el gesto explicito de voz (opt-in por definicion: solo
  // habla cuando se pulsa). Respeta mute/volumen (via audioEngine.setDucked
  // dentro de narrator) y nunca narra si el audio global esta muteado.
  describeBtn?.addEventListener('click', () => {
    const text = onDescribe?.();
    if (descriptionEl && typeof text === 'string') descriptionEl.textContent = text;
    const { lang, audio } = store.get();
    if (typeof text === 'string' && !audio.muted) {
      narrator?.speak(text, lang);
    }
  });

  narrationAutoCheckbox?.addEventListener('change', () => {
    store.set({ narrationAuto: Boolean(narrationAutoCheckbox.checked) });
  });

  compareABtn?.addEventListener('click', () => onCompareA?.());
  compareBBtn?.addEventListener('click', () => onCompareB?.());

  function fmtValue(value, lang) {
    if (value === null || value === undefined) return t(lang, 'noData');
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
  }

  function render(state) {
    const { lang, cell, compare, selectedPoint, dataset, audio, narrationAuto } = state;

    // El resultado accesible (dato/ubicacion/unidad/periodo/ausencia) se
    // actualiza SOLO con texto (aria-live="polite" en el contenedor
    // #acc-result ya existente en el HTML) en cuanto hay un cambio
    // confirmado, SIN iniciar voz: "Describir" sigue siendo el unico gesto
    // que habla (ver listener arriba), salvo que "Voz de navegacion" este
    // activada (ver main.js, que llama a narrator.speak con debounce).
    if (descriptionEl) {
      descriptionEl.textContent = describeState({ lang, selectedPoint, cell, dataset, audio });
    }
    if (narrationAutoCheckbox) narrationAutoCheckbox.checked = Boolean(narrationAuto);
    renderPlaces(lang);

    if (listenBtn) listenBtn.disabled = !cell || cell.value === null;
    if (compareABtn) compareABtn.disabled = !cell;
    if (compareBBtn) compareBBtn.disabled = !cell || !compare.a;

    if (compareResultEl) {
      if (compare.a && compare.b) {
        const diff =
          compare.b.value !== null && compare.a.value !== null
            ? (compare.b.value - compare.a.value).toFixed(2)
            : t(lang, 'noData');
        compareResultEl.hidden = false;
        compareResultEl.textContent = t(lang, 'compareResult', {
          periodA: compare.a.period,
          valueA: fmtValue(compare.a.value, lang),
          periodB: compare.b.period,
          valueB: fmtValue(compare.b.value, lang),
          diff
        });
      } else {
        compareResultEl.hidden = true;
      }
    }
  }

  // Botones de lugares creados UNA sola vez (listeners no se reasignan en
  // cada render); el texto (nombre ES/EN) se refresca en cada render() con
  // el idioma actual, en vez de quedar fijo con el idioma de carga.
  let placeButtons = [];

  function renderPlaces(lang) {
    for (const { site, btn } of placeButtons) {
      btn.textContent = site[lang]?.title ?? site.es.title;
    }
  }

  async function loadPlaces() {
    if (!placesList) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/peru-stories.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const sites = Array.isArray(json.sites) ? json.sites : [];
      placesList.innerHTML = '';
      placeButtons = [];
      for (const site of sites) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'action-btn';
        btn.addEventListener('click', () => {
          if (latInput) latInput.value = String(site.lat);
          if (lonInput) lonInput.value = String(site.lon);
          showError(null);
          onQuery?.({ lat: site.lat, lon: site.lon, period: periodSelect?.value || undefined });
        });
        li.appendChild(btn);
        placesList.appendChild(li);
        placeButtons.push({ site, btn });
      }
      renderPlaces(store.get().lang);
    } catch (err) {
      console.error('No se pudieron cargar los lugares de ejemplo', err);
    }
  }

  loadPlaces();
  render(store.get());

  return { render, describeState };
}
