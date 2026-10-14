import * as Cesium from 'cesium';

/**
 * Agrega marcadores de Cesium (entities tipo punto+etiqueta) para los
 * sitios de la seccion Peru. Cada marcador es clicable y llama a onSelect
 * con el sitio correspondiente; esto es un atajo visual EN EL GLOBO, pero
 * cada sitio tiene siempre un boton HTML equivalente en el panel Peru (ver
 * ui/peru-panel.js) para que la funcionalidad no dependa del canvas/WebGL.
 */
export function addPeruMarkers(viewer, sites, onSelect) {
  if (!viewer) return { entities: [], setVisible: () => {}, teardown: () => {} };

  const entities = sites.map((site) =>
    viewer.entities.add({
      show: false,
      id: `peru-site-${site.id}`,
      position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat),
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString('#f4a62a'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2
      },
      label: {
        text: site.id,
        font: '12px system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#12344A').withAlpha(0.7)
      }
    })
  );

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (!Cesium.defined(picked) || !picked.id) return;
    const site = sites.find((s) => picked.id.id === `peru-site-${s.id}`);
    if (site) onSelect(site);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  let visible = false;
  function setVisible(next) {
    if (next === visible) return;
    visible = next;
    for (const entity of entities) entity.show = next;
    viewer.scene?.requestRender();
  }

  function teardown() {
    handler.destroy();
    for (const entity of entities) viewer.entities.remove(entity);
    viewer.scene?.requestRender();
  }

  viewer.scene?.requestRender();
  return { entities, setVisible, teardown };
}
