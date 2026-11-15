// Renders assets/logo.svg (and the simplified small variant) to the PNG icons the extension needs.
// Usage: npm run icons
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'extension', 'icons');
const big = await readFile(path.join(root, 'assets', 'logo.svg'), 'utf8');
const small = await readFile(path.join(root, 'assets', 'logo-small.svg'), 'utf8');

const targets = [
  { size: 16, svg: small },
  { size: 32, svg: small },
  { size: 48, svg: big },
  { size: 128, svg: big },
  { size: 512, svg: big, name: 'logo-512.png', dir: path.join(root, 'assets') },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(svg, size, file, off) {
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  const filter = off ? 'filter: grayscale(1) opacity(0.55);' : '';
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;${filter}">${sized}</div></body></html>`
  );
  await page.locator('div').screenshot({ path: file, omitBackground: true });
}

for (const t of targets) {
  const dir = t.dir || outDir;
  await render(t.svg, t.size, path.join(dir, t.name || `icon-${t.size}.png`), false);
  if (!t.name) await render(t.svg, t.size, path.join(outDir, `icon-off-${t.size}.png`), true);
}
await browser.close();
console.log('Icons written to', outDir);
