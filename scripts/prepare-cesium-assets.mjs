// Copia los assets estaticos de CesiumJS (Workers, ThirdParty, Assets,
// Widgets) a public/cesium/ antes de `vite`/`vite build` (ver "predev" y
// "prebuild" en package.json).
//
// Reemplaza a vite-plugin-static-copy: ese plugin dependia de una version
// vulnerable de chokidar->braces (3 avisos "high" en `npm audit`, ver
// GHSA-vfj7-8cjw-p6xm). Como Cesium solo necesita estos archivos copiados
// una vez (no watchear cambios: node_modules/cesium no cambia durante el
// desarrollo), un script de copia simple con fs.cpSync alcanza y evita la
// dependencia vulnerable por completo (no es un downgrade: se elimina el
// plugin).
//
// public/cesium/ esta en .gitignore: se regenera en cada predev/prebuild,
// igual que node_modules.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cesiumSource = path.resolve(projectRoot, 'node_modules/cesium/Build/Cesium');
const destRoot = path.resolve(projectRoot, 'public/cesium');
const FOLDERS = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

if (!existsSync(cesiumSource)) {
  console.error(`No se encontro ${cesiumSource}. ¿Se corrio "npm install"?`);
  process.exit(1);
}

rmSync(destRoot, { recursive: true, force: true });
mkdirSync(destRoot, { recursive: true });

for (const folder of FOLDERS) {
  const src = path.join(cesiumSource, folder);
  const dest = path.join(destRoot, folder);
  if (!existsSync(src)) {
    console.warn(`Aviso: ${src} no existe, se omite.`);
    continue;
  }
  cpSync(src, dest, { recursive: true });
}

console.log(`Assets de Cesium copiados a ${destRoot}`);
