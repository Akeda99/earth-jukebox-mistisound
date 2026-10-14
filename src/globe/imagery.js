import * as Cesium from 'cesium';
import { BLUE_MARBLE_LAYER, buildGibsTileUrl } from '../config/gibs-layers.js';
import { createGibsTilingScheme } from './gibs-tiling-scheme.js';

/**
 * Construye el proveedor de imagenes de la capa base GIBS
 * (BlueMarble_ShadedRelief_Bathymetry), WMTS geografico EPSG:4326, usando el
 * esquema de tiling REAL de GIBS (ver gibs-tiling-scheme.js, basado en el
 * gibs.js oficial) en vez de un GeographicTilingScheme ordinario con
 * recuentos de tiles duplicados por nivel, y en vez de asumir un esquema XYZ
 * tipo Web Mercator.
 */
export function createGibsImageryProvider(layerConfig = BLUE_MARBLE_LAYER) {
  const tilingScheme = createGibsTilingScheme({
    rectangle: Cesium.Rectangle.fromDegrees(...layerConfig.rectangleDegrees)
  });

  return new Cesium.WebMapTileServiceImageryProvider({
    url: buildGibsTileUrl(layerConfig),
    layer: layerConfig.layer,
    style: layerConfig.style,
    format: layerConfig.format,
    tileMatrixSetID: layerConfig.tileMatrixSetId,
    maximumLevel: layerConfig.maximumLevel,
    tileWidth: layerConfig.tileWidth,
    tileHeight: layerConfig.tileHeight,
    tilingScheme,
    rectangle: tilingScheme.rectangle,
    credit: new Cesium.Credit(layerConfig.credit)
  });
}

/**
 * Agrega la capa base GIBS al visor y conecta su errorEvent a un callback
 * para manejar fallos de red/servicio (p.ej. mostrar un aviso y dejar el
 * globo con el color base en vez de quedar en blanco).
 */
export function addGibsBaseLayer(viewer, { onError } = {}) {
  const provider = createGibsImageryProvider();
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  viewer.scene?.requestRender();

  if (onError) {
    provider.errorEvent.addEventListener((err) => onError(err));
  }

  return layer;
}
