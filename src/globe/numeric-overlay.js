import * as Cesium from 'cesium';
import { ANOMALY_RANGE } from '../config/sonification.js';
import { clampAnomaly } from '../audio/mapping.js';

// Escala divergente fija (-5 .. +5): azul (frio) - blanco (neutro) -
// rojo (calido). El significado de estos colores es puramente la magnitud
// de la anomalia de temperatura; no tiene relacion con los colores del
// tema de la interfaz (ver src/styles.css).
const COLD = [33, 102, 172];
const NEUTRAL = [247, 247, 247];
const WARM = [178, 24, 43];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

/**
 * Color RGBA (0..255) para una anomalia dada en el rango fijo -5..+5.
 * value === null -> transparente (sin dato), nunca se dibuja como 0/neutro.
 */
export function colorForAnomaly(value, range = ANOMALY_RANGE) {
  if (value === null || value === undefined) return [0, 0, 0, 0];
  const clamped = clampAnomaly(value, range);
  const norm = (clamped - range.min) / (range.max - range.min); // 0..1
  const [r, g, b] =
    norm < 0.5 ? lerpColor(COLD, NEUTRAL, norm / 0.5) : lerpColor(NEUTRAL, WARM, (norm - 0.5) / 0.5);
  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

export function legendStops(range = ANOMALY_RANGE, steps = 9) {
  const stops = [];
  for (let i = 0; i < steps; i += 1) {
    const value = range.min + (i / (steps - 1)) * (range.max - range.min);
    stops.push({ value, color: colorForAnomaly(value, range) });
  }
  return stops;
}

/**
 * Dibuja el dataset (mismo JSON usado por el sonido) como una textura
 * georreferenciada: un pixel por celda de rejilla. Las filas del JSON van
 * de latitud ascendente (sur -> norte); una imagen de canvas tiene la fila
 * 0 arriba (norte), asi que se invierte el orden de filas al pintarla.
 */
export function buildOverlayCanvas(dataset) {
  const nLat = dataset.axes.lat_centers.length;
  const nLon = dataset.axes.lon_centers.length;
  const canvas = document.createElement('canvas');
  canvas.width = nLon;
  canvas.height = nLat;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(nLon, nLat);

  for (let latIdx = 0; latIdx < nLat; latIdx += 1) {
    const rowInImage = nLat - 1 - latIdx; // invierte: lat ascendente -> fila norte arriba
    for (let lonIdx = 0; lonIdx < nLon; lonIdx += 1) {
      const value = dataset.values[latIdx * nLon + lonIdx];
      const [r, g, b, a] = colorForAnomaly(value);
      const pixelIndex = (rowInImage * nLon + lonIdx) * 4;
      imageData.data[pixelIndex] = r;
      imageData.data[pixelIndex + 1] = g;
      imageData.data[pixelIndex + 2] = b;
      imageData.data[pixelIndex + 3] = a;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Prepara (de forma asincrona) el proveedor de imagenes para el overlay
 * numerico de un dataset, SIN tocar el visor todavia. Separado de
 * addOverlayLayer/removeOverlayLayer a proposito: el llamador (ver
 * main.js changePeriod) necesita poder abortar/descartar este resultado si,
 * para cuando el await termina, ya se pidio un periodo mas reciente, sin
 * haber tocado la capa actualmente visible mientras tanto (evita el hueco
 * en el que se ve el globo sin overlay, o se reinserta imagen vieja, por
 * una carrera entre dos cambios de periodo seguidos).
 */
export async function createOverlayProvider(dataset) {
  const canvas = buildOverlayCanvas(dataset);
  return Cesium.SingleTileImageryProvider.fromUrl(canvas.toDataURL(), {
    rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90)
  });
}

/** Agrega un proveedor ya listo como capa visible. No quita ninguna otra. */
export function addOverlayLayer(viewer, provider) {
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.alpha = 0.75;
  viewer.scene?.requestRender();
  return layer;
}

/** Quita una capa de overlay previa (si existe) del visor. */
export function removeOverlayLayer(viewer, layer) {
  if (layer) viewer.imageryLayers.remove(layer, true);
  if (layer) viewer.scene?.requestRender();
}
