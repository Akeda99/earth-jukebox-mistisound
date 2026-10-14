import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Esta prueba compara celdas del JSON exportado por
// scripts/prepare_gistemp.py contra el NetCDF original, leyendolo de nuevo
// de forma independiente (via Python/netCDF4) para detectar errores de
// decodificacion (escalado doble, orden de ejes, _FillValue, etc.).
//
// Se omite si no hay un archivo fuente local en work/raw/ o si Python +
// netCDF4 no estan disponibles: no se inventa un resultado de prueba.

const ROOT = path.resolve(__dirname, '..');
const GZ_PATH = path.join(ROOT, 'work', 'raw', 'gistemp1200_GHCNv4_ERSSTv5.nc.gz');
const NC_PATH = path.join(ROOT, 'work', 'raw', 'gistemp1200_GHCNv4_ERSSTv5.nc');
const JSON_PATH = path.join(ROOT, 'public', 'data', 'gistemp', '2023-01.json');

function pythonAvailable() {
  try {
    execFileSync('python', ['-c', 'import netCDF4'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const sourceAvailable = existsSync(GZ_PATH) || existsSync(NC_PATH);
const canRun = sourceAvailable && existsSync(JSON_PATH) && pythonAvailable();

describe.skipIf(!canRun)('export de GISTEMP 2023-01 vs NetCDF original', () => {
  let exported;
  let reference;

  // Celdas a comparar: 5 con dato real en distintas zonas de la rejilla,
  // mas una celda conocida como ausente (_FillValue) en 2023-01.
  const CELLS = [
    { lat_idx: 0, lon_idx: 0 },
    { lat_idx: 10, lon_idx: 20 },
    { lat_idx: 45, lon_idx: 90 },
    { lat_idx: 60, lon_idx: 135 },
    { lat_idx: 89, lon_idx: 179 },
    { lat_idx: 10, lon_idx: 5 } // celda ausente esperada
  ];

  beforeAll(() => {
    exported = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));

    const script = `
import gzip, json, shutil, sys, tempfile, os
import netCDF4 as nc

nc_path = ${JSON.stringify(NC_PATH)}
gz_path = ${JSON.stringify(GZ_PATH)}

if not os.path.exists(nc_path):
    tmp = tempfile.NamedTemporaryFile(suffix='.nc', delete=False)
    with gzip.open(gz_path, 'rb') as f_in:
        shutil.copyfileobj(f_in, tmp)
    tmp.close()
    nc_path = tmp.name

ds = nc.Dataset(nc_path)
time = ds.variables['time']
dates = nc.num2date(time[:], time.units, only_use_cftime_datetimes=False)
idx = next(i for i, d in enumerate(dates) if d.year == 2023 and d.month == 1)
var = ds.variables['tempanomaly']
data = var[idx, :, :]

cells = json.loads(sys.argv[1])
out = []
for c in cells:
    v = data[c['lat_idx'], c['lon_idx']]
    out.append(None if v is __import__('numpy').ma.masked else round(float(v), 4))
print(json.dumps(out))
`;

    const output = execFileSync('python', ['-c', script, JSON.stringify(CELLS)], {
      encoding: 'utf-8'
    });
    reference = JSON.parse(output.trim().split('\n').pop());
  });

  it('exporto el mismo numero de celdas que lat x lon', () => {
    expect(exported.cell_count).toBe(exported.axes.lat_centers.length * exported.axes.lon_centers.length);
    expect(exported.values.length).toBe(exported.cell_count);
  });

  it('coincide celda por celda con el NetCDF original (incluyendo una ausente)', () => {
    const nLon = exported.axes.lon_centers.length;
    CELLS.forEach((cell, i) => {
      const flatIndex = cell.lat_idx * nLon + cell.lon_idx;
      const exportedValue = exported.values[flatIndex];
      const referenceValue = reference[i];
      if (referenceValue === null) {
        expect(exportedValue).toBeNull();
      } else {
        expect(exportedValue).not.toBeNull();
        // Tolerancia ~0.000051 (numDigits=4 -> |diff| < 5e-5).
        expect(exportedValue).toBeCloseTo(referenceValue, 4);
      }
    });
  });

  it('contiene al menos una celda ausente (null) ademas de la comparada', () => {
    expect(exported.null_count).toBeGreaterThan(0);
    expect(exported.values.filter((v) => v === null).length).toBe(exported.null_count);
  });
});
