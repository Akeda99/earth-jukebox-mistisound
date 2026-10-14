import { describe, it, expect } from 'vitest';
import * as Cesium from 'cesium';
import { createGibsTilingScheme, GIBS_LEVELS } from '../src/globe/gibs-tiling-scheme.js';

// Verifica el esquema de tiling real de GIBS (ver gibs-tiling-scheme.js)
// contra los recuentos de tiles y resoluciones documentados en el gibs.js
// oficial de NASA GIBS, no contra un GeographicTilingScheme ordinario.

describe('createGibsTilingScheme', () => {
  const scheme = createGibsTilingScheme({
    rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90)
  });

  it('expone el recuento de tiles por nivel documentado (no geometrico 2^n)', () => {
    const expectedWidths = GIBS_LEVELS.map((l) => l.width);
    const expectedHeights = GIBS_LEVELS.map((l) => l.height);
    expectedWidths.forEach((w, level) => {
      expect(scheme.getNumberOfXTilesAtLevel(level)).toBe(w);
    });
    expectedHeights.forEach((h, level) => {
      expect(scheme.getNumberOfYTilesAtLevel(level)).toBe(h);
    });
    // Nivel 1 es 3x2, no 4x2 (no es una progresion geometrica simple).
    expect(scheme.getNumberOfXTilesAtLevel(1)).toBe(3);
    expect(scheme.getNumberOfYTilesAtLevel(1)).toBe(2);
  });

  it('nivel 0: el tile (0,0) arranca en el borde oeste (-180) y usa la resolucion tabulada', () => {
    const rect = scheme.tileXYToRectangle(0, 0, 0);
    const widthRad = GIBS_LEVELS[0].resolution * 512;
    expect(rect.west).toBeCloseTo(-Math.PI, 6);
    expect(rect.east).toBeCloseTo(-Math.PI + widthRad, 6);
    expect(rect.north).toBeCloseTo(Math.PI / 2, 6);
    expect(rect.south).toBeCloseTo(Math.PI / 2 - widthRad, 6);
  });

  it('nivel 0: el tile (1,0) continua inmediatamente despues del tile (0,0) en X', () => {
    const tile0 = scheme.tileXYToRectangle(0, 0, 0);
    const tile1 = scheme.tileXYToRectangle(1, 0, 0);
    expect(tile1.west).toBeCloseTo(tile0.east, 9);
  });

  it('resolucion por nivel coincide exactamente con la tabla documentada (gibs.js oficial)', () => {
    GIBS_LEVELS.forEach((entry, level) => {
      const rect = scheme.tileXYToRectangle(0, 0, level);
      const widthRad = entry.resolution * 512;
      expect(rect.east - rect.west).toBeCloseTo(widthRad, 9);
    });
  });

  it('positionToTileXY es consistente con tileXYToRectangle (ida y vuelta) en varios niveles', () => {
    const knownPoints = [
      { lon: -73.25, lat: -3.75 }, // Iquitos
      { lon: -70.82, lat: -13.93 }, // Quelccaya
      { lon: -81.5, lat: -5 }, // Pacifico frente a Piura
      { lon: 0, lat: 0 },
      { lon: 179.9, lat: 89.9 }
    ];
    for (let level = 0; level <= 5; level += 1) {
      for (const point of knownPoints) {
        const position = Cesium.Cartographic.fromDegrees(point.lon, point.lat);
        const tile = scheme.positionToTileXY(position, level);
        expect(tile).toBeDefined();
        expect(tile.x).toBeGreaterThanOrEqual(0);
        expect(tile.x).toBeLessThan(scheme.getNumberOfXTilesAtLevel(level));
        expect(tile.y).toBeGreaterThanOrEqual(0);
        expect(tile.y).toBeLessThan(scheme.getNumberOfYTilesAtLevel(level));

        const rect = scheme.tileXYToRectangle(tile.x, tile.y, level);
        // El punto original debe caer dentro (con tolerancia) del rectangulo
        // del tile que positionToTileXY le asigno.
        const lonRad = position.longitude;
        const latRad = position.latitude;
        expect(lonRad).toBeGreaterThanOrEqual(rect.west - 1e-9);
        expect(lonRad).toBeLessThanOrEqual(rect.east + 1e-9);
        expect(latRad).toBeGreaterThanOrEqual(rect.south - 1e-9);
        expect(latRad).toBeLessThanOrEqual(rect.north + 1e-9);
      }
    }
  });

  it('tileXYToNativeRectangle (heredado de Cesium) usa el tileXYToRectangle sobreescrito', () => {
    // El metodo heredado de Cesium.GeographicTilingScheme.prototype llama
    // internamente a this.tileXYToRectangle(...); al ser `this` la instancia
    // con el metodo sobreescrito, el rectangulo nativo (en grados, para la
    // proyeccion geografica EPSG:4326) debe coincidir con el rectangulo
    // geografico sobreescrito (convertido de radianes a grados), confirmando
    // que la ruta nativa SI usa el override y no el GeographicTilingScheme
    // por defecto de Cesium.
    const native = scheme.tileXYToNativeRectangle(2, 1, 1); // tile no trivial, nivel 1 (3x2)
    const geographic = scheme.tileXYToRectangle(2, 1, 1);
    expect(native.west).toBeCloseTo(Cesium.Math.toDegrees(geographic.west), 6);
    expect(native.east).toBeCloseTo(Cesium.Math.toDegrees(geographic.east), 6);
    expect(native.north).toBeCloseTo(Cesium.Math.toDegrees(geographic.north), 6);
    expect(native.south).toBeCloseTo(Cesium.Math.toDegrees(geographic.south), 6);
  });
});
