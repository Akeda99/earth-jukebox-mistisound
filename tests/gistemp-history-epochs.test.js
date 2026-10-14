import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Compara celdas de VARIAS epocas (1880 a 2026-08) del JSON exportado contra
// el NetCDF original, releido aqui con netCDF4 por un script independiente
// (no reutiliza el algoritmo de scripts/prepare_gistemp.py). Incluye una
// celda ausente (NULL) elegida por el propio lector, y comprueba que el SHA
// registrado en cada JSON es el del archivo original que ya existia.
// Se omite si no hay fuente local o Python+netCDF4: no se inventa resultado.

const ROOT = path.resolve(__dirname, '..');
const GZ_PATH = path.join(ROOT, 'work', 'raw', 'gistemp1200_GHCNv4_ERSSTv5.nc.gz');
const NC_PATH = path.join(ROOT, 'work', 'raw', 'gistemp1200_GHCNv4_ERSSTv5.nc');
const PYENV = path.join(ROOT, 'work', 'pyenv', 'Scripts', 'python.exe');
const PYTHON = existsSync(PYENV) ? PYENV : 'python';
const EPOCHS = ['1880-01', '1950-06', '1990-01', '2010-07', '2026-08'];
const CELLS = [
  [0, 0],
  [10, 20],
  [45, 90],
  [60, 135],
  [75, 20],
  [89, 179]
];

function pythonAvailable() {
  try {
    execFileSync(PYTHON, ['-c', 'import netCDF4'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const jsonPaths = EPOCHS.map((p) => path.join(ROOT, 'public', 'data', 'gistemp', `${p}.json`));
const canRun = (existsSync(GZ_PATH) || existsSync(NC_PATH)) && jsonPaths.every(existsSync) && pythonAvailable();

describe.skipIf(!canRun)('export GISTEMP multi-epoca vs NetCDF original', () => {
  let exported;
  let reference;

  beforeAll(() => {
    exported = Object.fromEntries(EPOCHS.map((p, i) => [p, JSON.parse(readFileSync(jsonPaths[i], 'utf-8'))]));
    const script = `
import gzip, json, shutil, sys, tempfile, os
import numpy as np
import netCDF4 as nc
nc_path, gz_path = sys.argv[1], sys.argv[2]
if not os.path.exists(nc_path):
    tmp = tempfile.NamedTemporaryFile(suffix='.nc', delete=False)
    with gzip.open(gz_path, 'rb') as f_in:
        shutil.copyfileobj(f_in, tmp)
    tmp.close()
    nc_path = tmp.name
ds = nc.Dataset(nc_path)
time = ds.variables['time']
dates = nc.num2date(time[:], time.units, only_use_cftime_datetimes=False)
months = {f'{d.year:04d}-{d.month:02d}': i for i, d in enumerate(dates)}
var = ds.variables['tempanomaly']
out = {'count': len(dates), 'first': min(months), 'last': max(months), 'epochs': {}}
for period in json.loads(sys.argv[3]):
    data = var[months[period], :, :]
    cells = {}
    for la, lo in json.loads(sys.argv[4]):
        v = data[la, lo]
        cells[f'{la}:{lo}'] = None if v is np.ma.masked else float(v)
    mask = np.ma.getmaskarray(data)
    masked = np.argwhere(mask)
    if len(masked):
        la, lo = [int(x) for x in masked[0]]
        cells[f'{la}:{lo}'] = None
    out['epochs'][period] = cells
print(json.dumps(out))
`;
    const output = execFileSync(PYTHON, ['-c', script, NC_PATH, GZ_PATH, JSON.stringify(EPOCHS), JSON.stringify(CELLS)], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024
    });
    reference = JSON.parse(output.trim().split('\n').pop());
  });

  it('el NetCDF original cubre 1880-01 a 2026-08 (1760 meses)', () => {
    expect(reference.count).toBe(1760);
    expect(reference.first).toBe('1880-01');
    expect(reference.last).toBe('2026-08');
  });

  it('coincide celda por celda en 5 epocas, con al menos una celda NULL', () => {
    let nullCells = 0;
    for (const period of EPOCHS) {
      const nLon = exported[period].axes.lon_centers.length;
      const cells = reference.epochs[period];
      expect(Object.keys(cells).length).toBeGreaterThanOrEqual(CELLS.length);
      for (const [key, refValue] of Object.entries(cells)) {
        const [la, lo] = key.split(':').map(Number);
        const got = exported[period].values[la * nLon + lo];
        if (refValue === null) {
          nullCells += 1;
          expect(got, `${period} ${key}`).toBeNull();
        } else {
          expect(got, `${period} ${key}`).not.toBeNull();
          expect(got).toBeCloseTo(refValue, 4);
        }
      }
    }
    expect(nullCells).toBeGreaterThan(0);
  });

  it('cada JSON conserva el SHA-256 del archivo original ya existente', () => {
    const sha = createHash('sha256').update(readFileSync(GZ_PATH)).digest('hex');
    for (const period of EPOCHS) {
      expect(exported[period].source.original_file_sha256).toBe(sha);
      expect(exported[period].period).toBe(period);
    }
  });

  it('el manifiesto lista 1760 periodos hasta 2026-08', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public', 'data', 'manifest.json'), 'utf-8'));
    const periods = manifest.files.map((f) => f.period).sort();
    expect(periods).toHaveLength(1760);
    expect(periods[0]).toBe('1880-01');
    expect(periods[periods.length - 1]).toBe('2026-08');
  });
});
