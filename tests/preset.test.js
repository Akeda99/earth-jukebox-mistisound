import { describe, it, expect, afterEach } from 'vitest';
import {
  encodePreset,
  decodePreset,
  resolvePresetPeriod,
  readSavedPresets,
  writeSavedPresets,
  PRESET_VERSION,
  MAX_FRAGMENT_LENGTH,
  ALLOWED_DJ_CHANNELS
} from '../src/sharing/preset.js';

describe('encodePreset/decodePreset (v2: canales DJ reales, no layers forzado)', () => {
  it('ida y vuelta: codifica y decodifica el mismo preset sin perder datos', () => {
    const preset = {
      mode: 'dj',
      selectedPoint: { lat: -13.93, lon: -70.82 },
      period: '2023-01',
      lang: 'es',
      seed: 'abc123',
      bpm: 84,
      channels: {
        temperature: { enabled: true, gainDb: -6, solo: true },
        rain: { enabled: false, gainDb: -10, solo: false }
      },
      dataVersions: { gistemp: 'sha256:abc', power: 1 }
    };
    const encoded = encodePreset(preset);
    const result = decodePreset(encoded);
    expect(result.ok).toBe(true);
    expect(result.preset).toMatchObject({
      version: PRESET_VERSION,
      mode: 'dj',
      selectedPoint: { lat: -13.93, lon: -70.82 },
      period: '2023-01',
      lang: 'es',
      seed: 'abc123',
      bpm: 84
    });
    expect(result.preset.channels).toEqual({
      temperature: { enabled: true, gainDb: -6, solo: true },
      rain: { enabled: false, gainDb: -10, solo: false }
    });
    expect(result.preset.dataVersions).toEqual({ gistemp: 'sha256:abc', power: 1 });
  });

  it('solo codifica los canales REALMENTE elegidos, no fuerza la lista completa', () => {
    const encoded = encodePreset({
      channels: { temperature: { enabled: true, gainDb: -3 } }
    });
    const result = decodePreset(encoded);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.preset.channels)).toEqual(['temperature']);
  });

  it('ida y vuelta sin punto ni periodo seleccionados (campos null)', () => {
    const encoded = encodePreset({ lang: 'en' });
    const result = decodePreset(encoded);
    expect(result.ok).toBe(true);
    expect(result.preset.selectedPoint).toBeNull();
    expect(result.preset.period).toBeNull();
    expect(result.preset.lang).toBe('en');
  });

  it('nunca codifica volumen maestro ni mute (no son parte del esquema v2)', () => {
    const encoded = encodePreset({ gainDb: -40, muted: true, selectedPoint: { lat: 0, lon: 0 } });
    const result = decodePreset(encoded);
    expect(result.ok).toBe(true);
    expect(result.preset.gainDb).toBeUndefined();
    expect(result.preset.muted).toBeUndefined();
  });

  it('rechaza una cadena malformada (no es base64url/JSON valido)', () => {
    expect(decodePreset('%%%no-es-base64%%%').ok).toBe(false);
    expect(decodePreset('').ok).toBe(false);
  });

  it('rechaza un fragmento mas largo que el limite documentado', () => {
    const tooLong = 'a'.repeat(MAX_FRAGMENT_LENGTH + 1);
    const result = decodePreset(tooLong);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('tooLong');
  });

  it('rechaza una version desconocida en vez de asumir la version actual', () => {
    const payload = JSON.stringify({ v: 999, lat: 0, lon: 0 });
    const encoded = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = decodePreset(encoded);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknownVersion');
    expect(result.version).toBe(999);
  });

  it('un preset v1 (esquema anterior) ya no se acepta en silencio: version desconocida explicita', () => {
    const payload = JSON.stringify({ v: 1, lat: 0, lon: 0, layers: ['gistemp'] });
    const encoded = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = decodePreset(encoded);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknownVersion');
  });

  it('rechaza coordenadas fuera de rango en vez de saturarlas', () => {
    const encoded = encodePreset({ selectedPoint: { lat: 95, lon: -70 } });
    const result = decodePreset(encoded);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalidFields');
    expect(result.fields).toContain('lat');
  });

  it('rechaza longitud fuera de rango (> 180)', () => {
    const encoded = encodePreset({ selectedPoint: { lat: 0, lon: 185 } });
    const result = decodePreset(encoded);
    expect(result.ok).toBe(false);
    expect(result.fields).toContain('lon');
  });

  it('rechaza un periodo con formato invalido', () => {
    const encoded = encodePreset({ period: 'no-es-un-periodo' });
    const result = decodePreset(encoded);
    expect(result.ok).toBe(false);
    expect(result.fields).toContain('period');
  });

  it('INFORMA (no descarta en silencio) un canal DJ desconocido', () => {
    const payload = JSON.stringify({
      v: PRESET_VERSION,
      channels: { temperature: { enabled: true, gainDb: -6 }, fuegoFalso: { enabled: true, gainDb: -6 } }
    });
    const encoded = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = decodePreset(encoded);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalidFields');
    expect(result.fields).toContain('channels');
  });

  it('rechaza una ganancia de canal fuera de rango', () => {
    const payload = JSON.stringify({
      v: PRESET_VERSION,
      channels: { temperature: { enabled: true, gainDb: 50 } }
    });
    const encoded = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = decodePreset(encoded);
    expect(result.ok).toBe(false);
    expect(result.fields).toContain('channels');
  });

  it('INFORMA una clave desconocida en dataVersions en vez de ignorarla', () => {
    const payload = JSON.stringify({ v: PRESET_VERSION, dataVersions: { gistemp: 'x', unknownSource: 'y' } });
    const encoded = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = decodePreset(encoded);
    expect(result.ok).toBe(false);
    expect(result.fields).toContain('dataVersions');
  });

  it('expone ALLOWED_DJ_CHANNELS con exactamente los 3 canales reales de hoy (incendios sigue bloqueado)', () => {
    expect(ALLOWED_DJ_CHANNELS).toEqual(['temperature', 'rain', 'ice']);
  });

  it('codifica/decodifica el canal de hielo igual que temperatura/lluvia', () => {
    const encoded = encodePreset({
      mode: 'dj',
      channels: { ice: { enabled: true, gainDb: -10, solo: false } }
    });
    const decoded = decodePreset(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.preset.channels.ice).toEqual({ enabled: true, gainDb: -10, solo: false });
  });

  it('dataVersions acepta la clave seaIce (hash de hielo G02135 por periodo)', () => {
    const encoded = encodePreset({ dataVersions: { seaIce: 'abc123' } });
    const decoded = decodePreset(encoded);
    expect(decoded.ok).toBe(true);
    expect(decoded.preset.dataVersions).toEqual({ seaIce: 'abc123' });
  });

  it('una clave desconocida en dataVersions sigue siendo invalida (whitelist estricta)', () => {
    const encoded = encodePreset({ dataVersions: { somethingElse: 'x' } });
    const decoded = decodePreset(encoded);
    expect(decoded.ok).toBe(false);
    expect(decoded.fields).toContain('dataVersions');
  });
});

describe('resolvePresetPeriod (periodo inexistente)', () => {
  it('acepta un periodo que si existe en el manifiesto', () => {
    const result = resolvePresetPeriod('2020-05', ['2020-04', '2020-05', '2020-06']);
    expect(result).toEqual({ ok: true, period: '2020-05' });
  });

  it('informa explicitamente un periodo con formato valido pero que ya no existe', () => {
    const result = resolvePresetPeriod('1800-01', ['2020-04', '2020-05']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('periodNotFound');
    expect(result.period).toBe('1800-01');
  });

  it('un preset sin periodo (null) se resuelve como "sin periodo", no como error', () => {
    expect(resolvePresetPeriod(null, ['2020-04'])).toEqual({ ok: true, period: null });
  });
});

describe('readSavedPresets/writeSavedPresets con storage bloqueado', () => {
  const originalLocalStorage = globalThis.localStorage;

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
  });

  it('writeSavedPresets devuelve false sin lanzar si localStorage.setItem lanza', () => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      }
    };
    expect(() => writeSavedPresets([{ name: 'x', encoded: 'y' }])).not.toThrow();
    expect(writeSavedPresets([{ name: 'x', encoded: 'y' }])).toBe(false);
  });

  it('readSavedPresets devuelve [] sin lanzar si localStorage.getItem lanza', () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      }
    };
    expect(() => readSavedPresets()).not.toThrow();
    expect(readSavedPresets()).toEqual([]);
  });

  it('readSavedPresets devuelve [] si el contenido guardado no es un arreglo JSON valido', () => {
    globalThis.localStorage = {
      getItem: () => '{"not":"an array"}'
    };
    expect(readSavedPresets()).toEqual([]);
  });
});

describe('preset v3: version musical', () => {
  const enc = (obj) =>
    btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('ida y vuelta v3 incluye music (version, estilo, motivo, duracion) y semilla', () => {
    const r = decodePreset(encodePreset({ seed: 'abc', selectedPoint: { lat: 1, lon: 2 }, period: '2023-12' }));
    expect(r.ok).toBe(true);
    expect(r.preset.version).toBe(3);
    expect(r.preset.legacyMusic).toBe(false);
    expect(r.preset.music).toEqual({ version: 2, style: 'piano-drops-ice', motif: 'CDEGA', duration: 20 });
    expect(r.preset.seed).toBe('abc');
  });

  it('un enlace v2 viejo abre sin error y se marca legacyMusic (sin afirmar la misma cancion)', () => {
    const r = decodePreset(enc({ v: 2, lat: -13.93, lon: -70.82, period: '2023-01', lang: 'es', seed: 's' }));
    expect(r.ok).toBe(true);
    expect(r.preset.legacyMusic).toBe(true);
    expect(r.preset.music).toBeNull();
    expect(r.preset.selectedPoint).toEqual({ lat: -13.93, lon: -70.82 });
  });

  it('version musical desconocida es un error explicito', () => {
    const r = decodePreset(enc({ v: 3, music: { v: 99, style: 'piano-drops-ice', motif: 'CDEGA', dur: 20 } }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknownMusicVersion');
    expect(r.version).toBe(99);
  });

  it('estilo, motivo o duracion invalidos se rechazan como campo music', () => {
    for (const music of [{ v: 2, style: 'x', motif: 'CDEGA', dur: 20 }, { v: 2, style: 'piano-drops-ice', motif: 'ZZ', dur: 20 }, { v: 2, style: 'piano-drops-ice', motif: 'CDEGA', dur: 999 }, 'texto']) {
      const r = decodePreset(enc({ v: 3, music }));
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalidFields');
      expect(r.fields).toContain('music');
    }
  });

  it('v4 sigue siendo version desconocida y el limite de longitud se mantiene', () => {
    expect(decodePreset(enc({ v: 4 })).error).toBe('unknownVersion');
    expect(encodePreset({ seed: 'x'.repeat(64), selectedPoint: { lat: 1, lon: 2 }, period: '2023-12', channels: { temperature: { enabled: true, gainDb: -6, solo: false }, rain: { enabled: true, gainDb: -6, solo: false }, ice: { enabled: true, gainDb: -6, solo: false } } }).length).toBeLessThan(MAX_FRAGMENT_LENGTH);
  });
});
