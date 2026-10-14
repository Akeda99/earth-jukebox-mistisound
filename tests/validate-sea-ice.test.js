import { describe, it, expect } from 'vitest';
import { validateSeaIceDataset } from '../src/data/validate.js';

function makeValid(overrides = {}) {
  return {
    dataset: 'NOAA/NSIDC G02135 Sea Ice Index v4.0',
    period: '2023-01',
    units: 'fraction (0.0-1.0) of valid ocean area covered by sea ice',
    grid_resolution_deg: 2,
    axes: { lat_centers: [-1, 0, 1], lon_centers: [-1, 0, 1] },
    values: [null, null, null, null, 0.5, null, null, null, null],
    coverage: [0, 0, 0, 0, 10, 0, 0, 0, 0],
    ...overrides
  };
}

describe('validateSeaIceDataset', () => {
  it('acepta un dataset valido con mayoria de celdas null (tierra/pole-hole/sin cobertura)', () => {
    expect(() => validateSeaIceDataset(makeValid())).not.toThrow();
  });

  it('rechaza si falta un campo string requerido (dataset/period/units)', () => {
    const { dataset, ...rest } = makeValid();
    expect(() => validateSeaIceDataset(rest)).toThrow();
  });

  it('rechaza si "values" esta vacio o ausente', () => {
    expect(() => validateSeaIceDataset(makeValid({ values: [] }))).toThrow();
    const { values, ...rest } = makeValid();
    expect(() => validateSeaIceDataset(rest)).toThrow();
  });

  it('rechaza si falta grid_resolution_deg', () => {
    const { grid_resolution_deg, ...rest } = makeValid();
    expect(() => validateSeaIceDataset(rest)).toThrow();
  });

  it('rechaza si "coverage" falta o tiene un tamano distinto de "values"', () => {
    const { coverage, ...rest } = makeValid();
    expect(() => validateSeaIceDataset(rest)).toThrow();
    expect(() => validateSeaIceDataset(makeValid({ coverage: [0, 0] }))).toThrow();
  });

  it('rechaza un valor fuera de 0.0-1.0 (nunca confundir fraccion con porcentaje)', () => {
    expect(() =>
      validateSeaIceDataset(makeValid({ values: [null, null, null, null, 85, null, null, null, null] }))
    ).toThrow();
  });

  it('rechaza si TODAS las celdas estan sin dato (sin ninguna celda real, no es un dataset usable)', () => {
    expect(() => validateSeaIceDataset(makeValid({ values: Array(9).fill(null) }))).toThrow();
  });

  it('acepta explicitamente un valor real 0.0 (fuente bajo el umbral de deteccion del 15%, distinto de null)', () => {
    const dataset = makeValid({ values: [null, null, null, null, 0, null, null, null, null] });
    expect(() => validateSeaIceDataset(dataset)).not.toThrow();
  });
});
