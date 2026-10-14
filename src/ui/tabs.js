/**
 * Pestanas Historia / Explorar / Peru / Accesible / DJ. Implementadas como un grupo simple
 * de botones nativos (igual que el selector de idioma), no como el patron
 * ARIA "tabs" con roving tabindex y flechas: eso evita tener que
 * interceptar teclas, y un grupo de botones normales ya es perfectamente
 * operable con Tab/Shift+Tab/Enter/Espacio y anunciable por lectores de
 * pantalla via aria-pressed.
 */
export function createTabs({ store }) {
  const buttons = Array.from(document.querySelectorAll('.tab-btn'));
  const panels = {
    history: document.getElementById('history-panel'),
    explore: document.getElementById('explore-panel'),
    peru: document.getElementById('peru-panel'),
    accessible: document.getElementById('accessible-panel'),
    dj: document.getElementById('dj-panel')
  };

  for (const btn of buttons) {
    btn.addEventListener('click', () => store.set({ activeTab: btn.dataset.tab }));
  }

  const sidePanel = document.getElementById('side-panel');
  let shownTab = null;

  function render(state) {
    document.documentElement.dataset.mode = state.activeTab;
    // Cada modo empieza arriba: no hereda el scroll del panel anterior.
    if (shownTab !== null && shownTab !== state.activeTab && sidePanel) sidePanel.scrollTop = 0;
    shownTab = state.activeTab;
    for (const btn of buttons) {
      btn.setAttribute('aria-pressed', String(btn.dataset.tab === state.activeTab));
    }
    for (const [key, panel] of Object.entries(panels)) {
      if (panel) panel.hidden = key !== state.activeTab;
    }
  }

  return { render };
}
