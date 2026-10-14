import * as Cesium from 'cesium';

const DRAG_THRESHOLD_PX = 6;

/**
 * Engancha clic/toque en el globo a un callback onPick({lat, lon}) en
 * grados. Descarta explicitamente:
 *  - arrastres (movimiento del puntero mayor a DRAG_THRESHOLD_PX entre el
 *    down y el up, tipicamente usado para rotar/orbitar la camara),
 *  - clics en espacio vacio (fuera del elipsoide, p.ej. el cielo).
 *
 * Devuelve una funcion para desconectar los manejadores.
 */
export function setupPicking(viewer, onPick) {
  const handler = viewer.screenSpaceEventHandler;
  let downPosition = null;
  let dragged = false;

  const onDown = (event) => {
    downPosition = event.position.clone();
    dragged = false;
  };

  const onMove = (event) => {
    if (!downPosition) return;
    const distance = Cesium.Cartesian2.distance(downPosition, event.endPosition);
    if (distance > DRAG_THRESHOLD_PX) dragged = true;
  };

  const onUp = (event) => {
    const wasDragged = dragged;
    downPosition = null;
    dragged = false;
    if (wasDragged) return;

    const cartesian = viewer.camera.pickEllipsoid(
      event.position,
      viewer.scene.globe.ellipsoid
    );
    if (!Cesium.defined(cartesian)) return; // espacio vacio: se descarta

    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    onPick({
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude)
    });
  };

  handler.setInputAction(onDown, Cesium.ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction(onMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(onUp, Cesium.ScreenSpaceEventType.LEFT_UP);

  return function teardown() {
    handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_UP);
  };
}
