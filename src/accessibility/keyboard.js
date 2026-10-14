// Soporte de teclado deliberadamente MINIMO: la app se apoya en el orden de
// tabulacion nativo del documento (Tab / Shift+Tab) y en los controles
// nativos (button, select, input), que ya manejan Enter/Espacio/flechas sin
// ningun codigo adicional. A proposito NO se agregan atajos de una sola
// letra globales ni se intercepta keydown sobre inputs/selects/textareas:
// eso rompe lectores de pantalla y atajos del propio navegador.
//
// Lo unico que se conecta aqui es el salto de "skip link" al contenido
// principal, que SI requiere manejo explicito de foco (mover el foco al
// contenido, no solo el scroll que hace el navegador por defecto en algunos
// casos de SPA sin recarga de pagina).
export function setupKeyboardSupport({ store } = {}) {
  const skipLink = document.getElementById('skip-link');
  const mainContent = document.getElementById('app-main');

  skipLink?.addEventListener('click', (event) => {
    if (!mainContent) return;
    event.preventDefault();
    if (!mainContent.hasAttribute('tabindex')) {
      mainContent.setAttribute('tabindex', '-1');
    }
    mainContent.focus();
  });

  return {};
}
