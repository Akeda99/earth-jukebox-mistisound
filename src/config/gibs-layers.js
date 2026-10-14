// Configuracion de la capa base GIBS (NASA Global Imagery Browse Services),
// WMTS, proyeccion geografica EPSG:4326.
//
// Fuentes usadas para estos valores (no inventados):
//  - Ejemplo oficial Cesium + GIBS geografico:
//    https://github.com/nasa-gibs/gibs-web-examples/blob/main/examples/cesium/geographic-epsg4326.html
//  - Esquema de tiling real (niveles, ancho/alto, resolucion):
//    https://raw.githubusercontent.com/nasa-gibs/gibs-web-examples/main/examples/cesium/gibs.js
//    (ver src/globe/gibs-tiling-scheme.js)
//  - GetCapabilities EPSG:4326 "best":
//    https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml
//
// La capa BlueMarble_ShadedRelief_Bathymetry se publica en el TileMatrixSet
// "500m" (resolucion nativa 500 m/px), con 9 niveles (0..8, ver GIBS_LEVELS
// en gibs-tiling-scheme.js), tiles de 512x512 y el TilingScheme geografico
// real de GIBS (recuentos de tiles no duplicados geometricamente por nivel,
// p.ej. 2x1 -> 3x2 -> 5x3 ...), tal como en el ejemplo oficial. No se asume
// un esquema XYZ tipo Web Mercator ni un GeographicTilingScheme ordinario.
//
// Se usa el endpoint KVP (wmts.cgi) en vez del REST estatico para evitar la
// ambiguedad del marcador de fecha {Time} en capas sin dimension temporal
// real como esta.

export const GIBS_WMTS_KVP_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi';

export const BLUE_MARBLE_LAYER = {
  layer: 'BlueMarble_ShadedRelief_Bathymetry',
  style: 'default',
  tileMatrixSetId: '500m',
  format: 'image/jpeg',
  tileWidth: 512,
  tileHeight: 512,
  maximumLevel: 8,
  numberOfLevelZeroTilesX: 2,
  numberOfLevelZeroTilesY: 1,
  rectangleDegrees: [-180.0, -90.0, 180.0, 90.0],
  credit:
    'Imagery courtesy NASA EOSDIS Global Imagery Browse Services (GIBS), ' +
    'operated by the NASA/GSFC/Earth Science Data and Information System ' +
    '(ESDIS) project.'
};

export function buildGibsTileUrl(layerConfig) {
  const { layer, style, tileMatrixSetId, format } = layerConfig;
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: layer,
    STYLE: style,
    TILEMATRIXSET: tileMatrixSetId,
    FORMAT: format
  });
  return `${GIBS_WMTS_KVP_URL}?${params.toString()}&TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}`;
}
