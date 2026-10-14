import { describe, it, expect } from 'vitest';
import {
  isAscending,
  validateAxes,
  nearestLatIndex,
  nearestLonIndex,
  cellIndex,
  findNearestCell
} from '../src/data/grid.js';

describe('isAscending', () => {
  it('true para arreglo estrictamente ascendente', () => {
    expect(isAscending([-90, -45, 0, 45, 90])).toBe(true);
  });

  it('false si hay un empate o descenso', () => {
    expect(isAscending([1, 1, 2])).toBe(false);
    expect(isAscending([2, 1, 0])).toBe(false);
  });
});

describe('validateAxes', () => {
  const okAxes = { lat_centers: [-1, 0, 1], lon_centers: [-1, 0, 1] };

  it('acepta ejes ascendentes con tamano consistente', () => {
    expect(validateAxes(okAxes, 9)).toEqual({ nLat: 3, nLon: 3 });
  });

  it('rechaza ejes vacios como rejilla valida', () => {
    expect(() => validateAxes({ lat_centers: [], lon_centers: [] })).toThrow();
  });

  it('rechaza ejes ausentes', () => {
    expect(() => validateAxes(null)).toThrow();
    expect(() => validateAxes({})).toThrow();
  });

  it('rechaza ejes no ascendentes', () => {
    expect(() => validateAxes({ lat_centers: [1, 0], lon_centers: [0, 1] })).toThrow();
  });

  it('rechaza si el numero de valores no coincide con lat x lon', () => {
    expect(() => validateAxes(okAxes, 8)).toThrow();
  });
});

describe('nearestLatIndex', () => {
  const lat = [-89, -45, 0, 45, 89];

  it('elige el centro mas cercano en el interior', () => {
    // |10-0|=10 es menor que |10-45|=35, asi que el centro 0 (indice 2) gana.
    expect(nearestLatIndex(10, lat)).toBe(2);
  });

  it('satura en el polo sur al centro extremo disponible', () => {
    expect(nearestLatIndex(-90, lat)).toBe(0);
  });

  it('satura en el polo norte al centro extremo disponible', () => {
    expect(nearestLatIndex(90, lat)).toBe(4);
  });
});

describe('nearestLonIndex (antimeridiano)', () => {
  const lon = [-179, -90, 0, 90, 179];

  it('resuelve +180 como circularmente cercano a 179 y -179', () => {
    const idx = nearestLonIndex(180, lon);
    expect([0, 4]).toContain(idx);
  });

  it('resuelve -180 igual que +180 (son el mismo meridiano)', () => {
    expect(nearestLonIndex(-180, lon)).toBe(nearestLonIndex(180, lon));
  });

  it('elige el centro mas cercano en el interior', () => {
    expect(nearestLonIndex(5, lon)).toBe(2);
  });
});

describe('cellIndex', () => {
  it('calcula el indice fila-mayor', () => {
    expect(cellIndex(0, 0, 4)).toBe(0);
    expect(cellIndex(1, 2, 4)).toBe(6);
  });
});

describe('findNearestCell', () => {
  const dataset = {
    axes: { lat_centers: [-45, 0, 45], lon_centers: [-90, 0, 90] },
    values: [1, 2, 3, 4, null, 6, 7, 8, 9]
  };

  it('devuelve la celda con sus centros e indice', () => {
    const cell = findNearestCell(40, 85, dataset);
    expect(cell.latIdx).toBe(2);
    expect(cell.lonIdx).toBe(2);
    expect(cell.value).toBe(9);
  });

  it('devuelve null (no cero) cuando la celda no tiene dato', () => {
    const cell = findNearestCell(2, 3, dataset);
    expect(cell.latIdx).toBe(1);
    expect(cell.lonIdx).toBe(1);
    expect(cell.value).toBeNull();
  });

  it('maneja un punto cerca del polo', () => {
    const cell = findNearestCell(89, 0, dataset);
    expect(cell.latCenter).toBe(45);
  });

  it('maneja un punto cerca del antimeridiano', () => {
    // 179 esta circularmente mas cerca de 90 (dist 89) que de -90 (dist 91).
    const cell = findNearestCell(0, 179, dataset);
    expect(cell.lonCenter).toBe(90);
  });
});
