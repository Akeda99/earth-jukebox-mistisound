import { chromium } from 'playwright';

const BASE_URL = process.argv[2] ?? 'http://localhost:5183';
const OUT_DIR = process.argv[3] ?? '/tmp/earth-jukebox-shots';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const messages = [];
page.on('console', (msg) => messages.push(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => messages.push(`[pageerror] ${err.message}`));
page.on('response', (res) => {
  const url = res.url();
  if (url.includes('gibs.earthdata.nasa.gov')) {
    messages.push(`[gibs-response] ${res.status()} ${url}`);
  }
});
page.on('requestfailed', (req) => {
  if (req.url().includes('gibs.earthdata.nasa.gov')) {
    messages.push(`[gibs-failed] ${req.failure()?.errorText} ${req.url()}`);
  }
});

await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2500);

await page.screenshot({ path: `${OUT_DIR}/01-explore.png`, fullPage: true });

// Explorar: activar sonido, click en el globo, comparar A/B
await page.click('#audio-toggle');
await page.waitForTimeout(200);
await page.mouse.click(430, 400);
await page.waitForTimeout(500);
const listenDisabled = await page.getAttribute('#listen-btn', 'disabled');
messages.push(`[check] listen-btn disabled after globe click: ${listenDisabled}`);
await page.click('#listen-btn');
await page.click('#compare-a-btn');
// A/B compara el MISMO lugar en dos periodos distintos (no dos lugares
// distintos: eso se invalida a proposito, ver recomputeSelectedCell en
// main.js). Se cambia el mes manteniendo el punto seleccionado.
await page.selectOption('#month-select', { index: 0 });
await page.waitForTimeout(600);
await page.click('#compare-b-btn');
await page.waitForTimeout(200);
const compareResultText = await page.textContent('#compare-result');
messages.push(`[check] compare-result: "${compareResultText}"`);
await page.screenshot({ path: `${OUT_DIR}/01b-explore-after-pick.png`, fullPage: true });

await page.click('.tab-btn[data-tab="peru"]');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT_DIR}/02-peru.png`, fullPage: true });

// Peru: visitar un sitio y revisar que el valor de celda se vincule
await page.click('#peru-sites .peru-site-btn >> nth=0');
await page.waitForTimeout(800);
const peruValueText = await page.textContent('.peru-cell-value');
messages.push(`[check] peru-cell-value after visiting site: "${peruValueText}"`);
await page.screenshot({ path: `${OUT_DIR}/02b-peru-visited.png`, fullPage: true });

await page.click('.tab-btn[data-tab="accessible"]');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT_DIR}/03-accessible.png`, fullPage: true });

// Flujo accesible: consultar coordenadas invalidas -> debe mostrar error, NO enviar
await page.fill('#acc-lat', '200');
await page.fill('#acc-lon', '0');
await page.click('#accessible-form button[type="submit"]');
await page.waitForTimeout(300);
const errorText = await page.textContent('#acc-form-error');
messages.push(`[check] acc-form-error after invalid coords: "${errorText}"`);

// Coordenadas validas (Iquitos) -> debe consultar y permitir describir
await page.fill('#acc-lat', '-3.75');
await page.fill('#acc-lon', '-73.25');
await page.click('#accessible-form button[type="submit"]');
await page.waitForTimeout(800);
await page.click('#acc-describe-btn');
await page.waitForTimeout(200);
const descText = await page.textContent('#acc-description');
messages.push(`[check] acc-description: "${descText}"`);
await page.screenshot({ path: `${OUT_DIR}/04-accessible-queried.png`, fullPage: true });

// Viewport angosto (360px) -> comprobar que no haya overflow horizontal
await page.setViewportSize({ width: 360, height: 740 });
await page.waitForTimeout(300);
const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
messages.push(`[check] 360px viewport: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);
await page.screenshot({ path: `${OUT_DIR}/05-narrow-360.png`, fullPage: true });

await browser.close();

console.log(messages.join('\n'));
