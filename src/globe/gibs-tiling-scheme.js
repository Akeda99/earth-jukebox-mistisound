import * as Cesium from 'cesium';

// Esquema de tiling WMTS geografico (EPSG:4326) real de GIBS, tal como lo
// define el ejemplo oficial de NASA GIBS + Cesium:
// https://raw.githubusercontent.com/nasa-gibs/gibs-web-examples/main/examples/cesium/gibs.js
//
// IMPORTANTE: este NO es un GeographicTilingScheme ordinario con recuentos
// 2x1 duplicados por nivel. GIBS define, nivel a nivel, un numero de tiles
// en X/Y y una resolucion (radianes/pixel) que NO siguen una progresion
// geometrica simple (p.ej. nivel 1 es 3x2, no 4x2). Usar GeographicTilingScheme
// sin estos overrides produce un mapeo incorrecto de TileRow/TileCol y por lo
// tanto imagenes desalineadas o en blanco en niveles > 0.
const TILE_PIXELS = 512;

const LEVELS = [
  { width: 2, height: 1, resolution: 0.009817477042468103 },
  { width: 3, height: 2, resolution: 0.004908738521234052 },
  { width: 5, height: 3, resolution: 0.002454369260617026 },
  { width: 10, height: 5, resolution: 0.001227184630308513 },
  { width: 20, height: 10, resolution: 0.0006135923151542565 },
  { width: 40, height: 20, resolution: 0.00030679615757712823 },
  { width: 80, height: 40, resolution: 0.00015339807878856412 },
  { width: 160, height: 80, resolution: 0.00007669903939428206 },
  { width: 320, height: 160, resolution: 0.00003834951969714103 }
];

export const GIBS_TILE_PIXELS = TILE_PIXELS;
export const GIBS_LEVELS = LEVELS;

/**
 * Construye un GeographicTilingScheme de Cesium y le sobreescribe los
 * metodos que determinan el recuento de tiles por nivel y la conversion
 * tile<->rectangulo, para que coincidan exactamente con el esquema real de
 * GIBS (en vez de los supuestos por defecto de Cesium). tileXYToNativeRectangle
 * se hereda del prototipo de Cesium y llama a `this.tileXYToRectangle(...)`,
 * por lo que automaticamente usa la version sobreescrita (se verifica en
 * tests/gibs-tiling.test.js).
 */
export function createGibsTilingScheme(options = {}) {
  const scheme = new Cesium.GeographicTilingScheme(options);
  const rectangle = scheme.rectangle;

  scheme.getNumberOfXTilesAtLevel = function (level) {
    const entry = LEVELS[level];
    return entry ? entry.width : LEVELS[LEVELS.length - 1].width;
  };

  scheme.getNumberOfYTilesAtLevel = function (level) {
    const entry = LEVELS[level];
    return entry ? entry.height : LEVELS[LEVELS.length - 1].height;
  };

  scheme.tileXYToRectangle = function (x, y, level, result) {
    const entry = LEVELS[level] ?? LEVELS[LEVELS.length - 1];
    const xTileWidth = entry.resolution * TILE_PIXELS;
    const yTileHeight = entry.resolution * TILE_PIXELS;
    const west = x * xTileWidth + rectangle.west;
    const east = (x + 1) * xTileWidth + rectangle.west;
    const north = rectangle.north - y * yTileHeight;
    const south = rectangle.north - (y + 1) * yTileHeight;
    if (!result) {
      result = new Cesium.Rectangle(0, 0, 0, 0);
    }
    result.west = west;
    result.south = south;
    result.east = east;
    result.north = north;
    return result;
  };

  scheme.positionToTileXY = function (position, level, result) {
    if (!Cesium.Rectangle.contains(rectangle, position)) {
      return undefined;
    }
    const entry = LEVELS[level] ?? LEVELS[LEVELS.length - 1];
    const xTiles = entry.width;
    const yTiles = entry.height;
    const xTileWidth = entry.resolution * TILE_PIXELS;
    const yTileHeight = entry.resolution * TILE_PIXELS;

    let longitude = position.longitude;
    if (rectangle.east < rectangle.west) {
      longitude += Cesium.Math.TWO_PI;
    }
    let xTileCoordinate = Math.floor((longitude - rectangle.west) / xTileWidth);
    if (xTileCoordinate >= xTiles) xTileCoordinate = xTiles - 1;
    if (xTileCoordinate < 0) xTileCoordinate = 0;

    const latitude = position.latitude;
    let yTileCoordinate = Math.floor((rectangle.north - latitude) / yTileHeight);
    if (yTileCoordinate >= yTiles) yTileCoordinate = yTiles - 1;
    if (yTileCoordinate < 0) yTileCoordinate = 0;

    if (!result) {
      result = new Cesium.Cartesian2(0, 0);
    }
    result.x = xTileCoordinate;
    result.y = yTileCoordinate;
    return result;
  };

  return scheme;
}
