import '../bootstrap-cesium.js';
import * as Cesium from 'cesium';
import { t } from '../i18n/index.js';

/**
 * Crea el Viewer de Cesium sin ningun servicio de Cesium ion: sin token,
 * terreno elipsoidal (sin pedir el terreno mundial de ion), geocoder y
 * selector de capas base desactivados. La capa base real la agrega
 * src/globe/imagery.js aparte.
 *
 * Si WebGL no esta disponible, Cesium lanza al construir el Viewer; en ese
 * caso devolvemos null para que la UI pueda mostrar un mensaje de fallback
 * en vez de que la pagina quede rota.
 */
export function createGlobe(container) {
  Cesium.Ion.defaultAccessToken = undefined;

  let viewer;
  try {
    viewer = new Cesium.Viewer(container, {
      imageryProvider: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: true,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity
    });
  } catch (err) {
    return { viewer: null, error: err };
  }

  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#12344A');
  viewer.scene.screenSpaceCameraController.enableTilt = true;
  viewer.scene.screenSpaceCameraController.enableRotate = true;
  viewer.scene.screenSpaceCameraController.enableZoom = true;

  viewer.creditDisplay.addStaticCredit(
    new Cesium.Credit(
      '<a href="https://cesium.com/" target="_blank" rel="noopener">CesiumJS</a>',
      true
    )
  );

  return { viewer, error: null };
}

/**
 * Localiza en ES/EN los textos propios que Cesium genera en ingles fijo
 * (titulo del boton "Home" y el enlace "Data attribution" de creditos),
 * tocando solo el DOM ya renderizado (nunca el codigo de la libreria: ver
 * node_modules/cesium). Debe volver a llamarse cuando cambia el idioma
 * (ver main.js: setLang llama a esta funcion ademas de applyStaticTexts).
 */
export function localizeGlobeWidgets(viewer, lang) {
  if (!viewer?.container) return;
  const homeButton = viewer.container.querySelector('.cesium-home-button');
  if (homeButton) {
    const text = t(lang, 'globeHomeButton');
    homeButton.title = text;
    homeButton.setAttribute('aria-label', text);
  }
  const creditsExpand = viewer.container.querySelector('.cesium-credit-expand-link');
  if (creditsExpand) {
    const text = t(lang, 'globeCreditsExpand');
    creditsExpand.textContent = text;
    creditsExpand.setAttribute('aria-label', text);
  }
}
