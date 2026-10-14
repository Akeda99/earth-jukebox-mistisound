import { t } from '../i18n/index.js';
import { addPeruMarkers } from '../globe/peru-markers.js';

/**
 * Panel "Peru": lista de sitios con botones HTML (equivalentes a los
 * marcadores del globo, para que funcione aunque Cesium/WebGL no haya
 * inicializado), historia breve ES/EN con fuente y pregunta para explorar,
 * boton opcional de narracion por voz, y el valor de la celda GISTEMP
 * seleccionada cuando el punto activo corresponde a ese sitio (con una nota
 * explicita de que ese valor NO es masa glaciar ni un indice de El Nino).
 */
export async function createPeruPanel({ store, onVisit, narrator, viewer }) {
  const container = document.getElementById('peru-sites');
  const detailEl = document.getElementById('peru-detail');
  const listenBtn = document.getElementById('peru-listen-btn');

  let sites = [];
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/peru-stories.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    sites = Array.isArray(json.sites) ? json.sites : [];
  } catch (err) {
    console.error('No se pudieron cargar las historias de Peru', err);
  }

  let selectedSiteId = null;

  function selectSite(site) {
    selectedSiteId = site.id;
    narrator?.cancel();
    onVisit?.(site.lat, site.lon);
    render(store.get());
  }

  if (container) {
    container.innerHTML = '';
    for (const site of sites) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-btn peru-site-btn';
      btn.dataset.siteId = site.id;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => selectSite(site));
      container.appendChild(btn);
    }
  }

  let markers = null;
  if (viewer && sites.length > 0) {
    markers = addPeruMarkers(viewer, sites, (site) => selectSite(site));
  }

  listenBtn?.addEventListener('click', () => {
    const state = store.get();
    const site = sites.find((s) => s.id === selectedSiteId);
    if (!site) return;
    if (narrator.isSpeaking()) {
      narrator.cancel();
      return;
    }
    const content = site[state.lang] ?? site.es;
    const text = `${content.title}. ${content.body} ${content.question}`;
    narrator.speak(text, state.lang);
  });

  narrator?.onChange(() => render(store.get()));

  function render(state) {
    markers?.setVisible(state.activeTab === 'peru');
    if (container) {
      for (const btn of container.querySelectorAll('.peru-site-btn')) {
        const site = sites.find((s) => s.id === btn.dataset.siteId);
        const content = site?.[state.lang] ?? site?.es;
        btn.textContent = content?.title ?? btn.dataset.siteId;
        btn.setAttribute('aria-pressed', String(btn.dataset.siteId === selectedSiteId));
      }
    }

    if (!detailEl) return;
    const site = sites.find((s) => s.id === selectedSiteId);
    if (!site) {
      detailEl.hidden = true;
      if (listenBtn) listenBtn.hidden = true;
      return;
    }

    const content = site[state.lang] ?? site.es;
    detailEl.hidden = false;
    const titleEl = detailEl.querySelector('.peru-title');
    const bodyEl = detailEl.querySelector('.peru-body');
    const questionEl = detailEl.querySelector('.peru-question');
    const noteEl = detailEl.querySelector('.peru-note');
    const sourceEl = detailEl.querySelector('.peru-source');
    const valueEl = detailEl.querySelector('.peru-cell-value');

    if (titleEl) titleEl.textContent = content.title;
    if (bodyEl) bodyEl.textContent = content.body;
    if (questionEl) questionEl.textContent = content.question;
    if (noteEl) noteEl.textContent = content.note;
    if (sourceEl) {
      sourceEl.href = site.source;
      sourceEl.textContent = t(state.lang, 'peruSourceLabel');
    }

    const { selectedPoint, cell, dataset } = state;
    const closeEnough =
      selectedPoint &&
      Math.abs(selectedPoint.lat - site.lat) < 0.75 &&
      Math.abs(selectedPoint.lon - site.lon) < 0.75;
    if (valueEl) {
      if (closeEnough && cell && dataset) {
        valueEl.textContent =
          cell.value === null
            ? t(state.lang, 'noData')
            : `${cell.value >= 0 ? '+' : ''}${cell.value.toFixed(2)} ${dataset.units} (${dataset.period})`;
      } else {
        valueEl.textContent = t(state.lang, 'peruCellPending');
      }
    }

    if (listenBtn) {
      listenBtn.hidden = !narrator?.isSupported();
      listenBtn.textContent = t(state.lang, narrator?.isSpeaking() ? 'narrationStop' : 'narrationListen');
    }
  }

  render(store.get());

  return { render };
}
