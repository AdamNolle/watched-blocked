// Renders the README hero images and Chrome Web Store graphics.
// Run `npm run screenshots` first so assets/popup-*.png are current.
// Usage: npm run assets
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataUrl = (file) => `data:image/png;base64,${readFileSync(path.join(root, file)).toString('base64')}`;
const logo = dataUrl('extension/icons/icon-128.png');
const popupLight = dataUrl('assets/popup-light.png');
const popupDark = dataUrl('assets/popup-dark.png');

const THEMES = {
  light: { page: '#f4f4f5', panel: '#ffffff', line: '#e4e4e7', text: '#0f0f0f', muted: '#71717a', skeleton: '#e7e7ea', shadow: '0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.06)' },
  dark: { page: '#0d1117', panel: '#18181b', line: '#27272a', text: '#f4f4f5', muted: '#a1a1aa', skeleton: '#2a2a2e', shadow: '0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3)' },
};

// Placeholder videos. `w` = percent watched.
const VIDEOS = {
  a: { hue: 12, w: 100, len: '12:04' },
  b: { hue: 205, len: '8:31' },
  c: { hue: 280, w: 64, len: '21:47' },
  d: { hue: 150, len: '4:12' },
  e: { hue: 42, w: 100, len: '15:09' },
  f: { hue: 330, len: '9:58' },
  g: { hue: 185, len: '33:20' },
  h: { hue: 95, len: '6:45' },
  i: { hue: 240, len: '11:02' },
};

function card(id, t) {
  const v = VIDEOS[id];
  const bar = v.w
    ? `<div class="track"><div class="bar" style="width:${v.w}%"></div></div>`
    : '';
  return `
    <div class="card">
      <div class="thumb" style="background:linear-gradient(135deg,hsl(${v.hue} 70% 62%),hsl(${(v.hue + 40) % 360} 65% 42%))">
        <span class="len">${v.len}</span>${bar}
      </div>
      <div class="meta">
        <div class="avatar" style="background:hsl(${v.hue} 45% ${t === THEMES.dark ? 35 : 80}%)"></div>
        <div class="lines"><div class="l1"></div><div class="l2"></div></div>
      </div>
    </div>`;
}

function baseCss(t) {
  return `
    * { box-sizing: border-box; margin: 0; }
    body { font-family: 'Segoe UI', Roboto, system-ui, sans-serif; background: ${t.page}; color: ${t.text}; }
    .panel { background: ${t.panel}; border: 1px solid ${t.line}; border-radius: 18px; box-shadow: ${t.shadow}; padding: 26px; }
    .label { font-size: 15px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: ${t.muted}; margin-bottom: 18px; display: flex; align-items: center; gap: 10px; }
    .label .dot { width: 9px; height: 9px; border-radius: 50%; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px 16px; }
    .thumb { position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; }
    .len { position: absolute; right: 7px; bottom: 9px; padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.78); color: #fff; font-size: 11px; font-weight: 600; }
    .track { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; background: rgba(255,255,255,.45); }
    .bar { height: 100%; background: #ff0000; }
    .meta { display: flex; gap: 9px; margin-top: 10px; }
    .avatar { flex: none; width: 26px; height: 26px; border-radius: 50%; }
    .lines { flex: 1; padding-top: 2px; }
    .l1, .l2 { height: 9px; border-radius: 5px; background: ${t.skeleton}; }
    .l1 { width: 92%; }
    .l2 { width: 58%; margin-top: 7px; }
  `;
}

function heroHtml(t, { width, height, headline }) {
  const before = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => card(id, t)).join('');
  const after = ['b', 'd', 'f', 'g', 'h', 'i'].map((id) => card(id, t)).join('');
  return `<!doctype html><html><head><style>${baseCss(t)}
    .wrap { width: ${width}px; ${height ? `height: ${height}px;` : ''} padding: ${headline ? 56 : 36}px 40px 40px; display: flex; flex-direction: column; justify-content: center; }
    h1 { font-size: 40px; font-weight: 650; letter-spacing: -.02em; margin-bottom: 34px; display: flex; align-items: center; gap: 16px; }
    h1 img { width: 48px; height: 48px; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
    ${headline ? '' : 'body { background: transparent; }'}
  </style></head><body><div class="wrap">
    ${headline ? `<h1><img src="${logo}">${headline}</h1>` : ''}
    <div class="cols">
      <div class="panel"><div class="label"><span class="dot" style="background:#ff0000"></span>Before</div><div class="grid">${before}</div></div>
      <div class="panel"><div class="label"><span class="dot" style="background:#22c55e"></span>After</div><div class="grid">${after}</div></div>
    </div>
  </div></body></html>`;
}

function popupShotHtml(t, popup, { width, height, headline }) {
  return `<!doctype html><html><head><style>${baseCss(t)}
    .wrap { width: ${width}px; height: ${height}px; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 72px; padding: 0 110px; }
    h1 { font-size: 46px; line-height: 1.12; font-weight: 650; letter-spacing: -.02em; }
    p { margin-top: 18px; font-size: 20px; line-height: 1.5; color: ${t.muted}; max-width: 460px; }
    .shot { width: 300px; border-radius: 14px; border: 1px solid ${t.line}; box-shadow: ${t.shadow}, 0 24px 60px rgba(0,0,0,.12); }
  </style></head><body><div class="wrap">
    <div><h1>${headline}</h1><p>Turn it off for any part of YouTube, set how much counts as watched, or dim videos instead of hiding them.</p></div>
    <img class="shot" src="${popup}">
  </div></body></html>`;
}

function promoHtml({ width, height }) {
  return `<!doctype html><html><head><style>
    * { margin: 0; box-sizing: border-box; }
    body { width: ${width}px; height: ${height}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
      background: radial-gradient(120% 90% at 50% 0%, #2a2a2f 0%, #111113 70%); font-family: 'Segoe UI', Roboto, system-ui, sans-serif; color: #fff; }
    img { width: 104px; height: 104px; }
    h1 { font-size: 34px; font-weight: 650; letter-spacing: -.02em; }
  </style></head><body><img src="${logo}"><h1>Watched Blocked</h1></body></html>`;
}

const jobs = [
  { file: 'assets/hero-light.png', html: heroHtml(THEMES.light, { width: 1400 }), width: 1400, height: 0, scale: 2 },
  { file: 'assets/hero-dark.png', html: heroHtml(THEMES.dark, { width: 1400 }), width: 1400, height: 0, scale: 2 },
  { file: 'store/screenshot-1.png', html: heroHtml(THEMES.light, { width: 1280, height: 800, headline: 'Hide videos you’ve already watched' }), width: 1280, height: 800, scale: 1 },
  { file: 'store/screenshot-2.png', html: popupShotHtml(THEMES.light, popupLight, { width: 1280, height: 800, headline: 'Choose where it works' }), width: 1280, height: 800, scale: 1 },
  { file: 'store/screenshot-3.png', html: popupShotHtml(THEMES.dark, popupDark, { width: 1280, height: 800, headline: 'Works in dark mode' }), width: 1280, height: 800, scale: 1 },
  { file: 'store/promo-small.png', html: promoHtml({ width: 440, height: 280 }), width: 440, height: 280, scale: 1 },
  { file: 'store/promo-marquee.png', html: promoHtml({ width: 1400, height: 560 }), width: 1400, height: 560, scale: 1 },
];

mkdirSync(path.join(root, 'store'), { recursive: true });
const browser = await chromium.launch();
for (const job of jobs) {
  const page = await browser.newPage({ viewport: { width: job.width, height: job.height || 800 }, deviceScaleFactor: job.scale });
  await page.setContent(job.html);
  if (job.height) {
    await page.screenshot({ path: path.join(root, job.file), clip: { x: 0, y: 0, width: job.width, height: job.height } });
  } else {
    // Size to content.
    await page.locator('.wrap').screenshot({ path: path.join(root, job.file), omitBackground: true });
  }
  await page.close();
  console.log('wrote', job.file);
}
await browser.close();
