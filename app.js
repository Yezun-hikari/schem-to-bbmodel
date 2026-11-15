import { readNbt } from './src/nbt.js';
import { toGrid } from './src/formats.js';
import { convert } from './src/convert.js';

// Releases with flattened block names (1.13+) available as branches of InventivetalentDev/minecraft-assets
const VERSIONS = ['1.21.11', '1.21.10', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21',
  '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.15.2', '1.14.4', '1.13.2'];
const LEGACY_URL = 'https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-data@master/data/pc/common/legacy.json';

const $ = (id) => document.getElementById(id);
const versionSel = $('version'), bbSel = $('bbversion'), log = $('log'), drop = $('drop');

versionSel.innerHTML = VERSIONS.map((v) => `<option>${v}</option>`).join('');
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
const bbFor = (v) => (cmp(v, '1.21.6') < 0 ? '1.9.0' : cmp(v, '1.21.11') < 0 ? '1.21.6' : '1.21.11');
versionSel.onchange = () => { bbSel.value = bbFor(versionSel.value); };
versionSel.onchange();

$('theme').onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch {}
};

const caches = {};
function assetsFor(version) {
  if (caches[version]) return caches[version];
  const base = `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${version}/assets/minecraft/`;
  const jsonCache = new Map(), texCache = new Map();
  return (caches[version] = {
    json(p) {
      if (!jsonCache.has(p)) jsonCache.set(p, fetch(base + p).then((r) => (r.ok ? r.json() : null)).catch(() => null));
      return jsonCache.get(p);
    },
    pixels(p, tint) {
      const key = p + '|' + tint;
      if (!texCache.has(key)) texCache.set(key, loadPixels(base + 'textures/' + p + '.png', tint).catch(() => null));
      return texCache.get(key);
    },
    encode(img) {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      return c.toDataURL('image/png');
    },
  });
}

async function loadPixels(url, tint) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const img = await createImageBitmap(await r.blob());
  const size = img.width; // animated strips: keep the first square frame
  const c = document.createElement('canvas');
  c.width = size; c.height = Math.min(img.height, size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  if (tint !== null && tint !== undefined) {
    const rgb = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
    for (let i = 0; i < d.data.length; i += 4) for (let k = 0; k < 3; k++) d.data[i + k] = (d.data[i + k] * rgb[k]) / 255;
  }
  return { data: d.data, width: d.width, height: d.height };
}

let legacyMap;
const loadLegacyMap = () => (legacyMap ??= fetch(LEGACY_URL).then((r) => r.json()).then((j) => j.blocks));

async function handle(file) {
  const li = document.createElement('li');
  li.textContent = `${file.name}: wird gelesen …`;
  log.prepend(li);
  try {
    const grid = await toGrid(await readNbt(await file.arrayBuffer()), loadLegacyMap);
    li.textContent = `${file.name}: ${grid.size.join('×')} Blöcke, lade Assets für ${versionSel.value} …`;
    const name = file.name.replace(/\.[^.]+$/, '');
    const { bbmodel, stats } = await convert(grid, assetsFor(versionSel.value), {
      name, fit: $('fit').checked, bakeTint: $('tint').checked, flatColor: $('flat').checked || $('voxel').checked, voxel: $('voxel').checked, javaBlockVersion: bbSel.value,
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(bbmodel)], { type: 'application/json' }));
    li.innerHTML = '';
    const a = Object.assign(document.createElement('a'), { href: url, download: name + '.bbmodel', textContent: name + '.bbmodel herunterladen' });
    const info = document.createElement('small');
    const notes = [`${stats.cubes} Würfel`, `${stats.size.join('×')} Blöcke`];
    if (stats.scale < 1) notes.push(`skaliert auf ${(stats.scale * 100).toFixed(1)} %`);
    if (stats.cubes > 5000) notes.push('sehr viele Würfel – Blockbench kann langsam werden');
    if (stats.skipped.length) notes.push('ohne Geometrie übersprungen: ' + stats.skipped.map(([n, c]) => `${n.replace('minecraft:', '')} (${c})`).join(', '));
    if (stats.missingTextures.length) notes.push('Texturen fehlen: ' + stats.missingTextures.join(', '));
    info.textContent = notes.join(' · ');
    li.append(a, info);
    a.click();
  } catch (e) {
    console.error(e);
    li.className = 'err';
    li.textContent = `${file.name}: ${e.message}`;
  }
}

const handleAll = (files) => [...files].forEach(handle);
$('file').onchange = (e) => { handleAll(e.target.files); e.target.value = ''; };
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => handleAll(e.dataTransfer.files));
// Dropping next to the zone should not open the file in the browser
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());
