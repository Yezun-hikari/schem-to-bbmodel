// Node self-check: builds small .schem / .litematic files, parses them and converts with live vanilla assets.
// Run: node test/selfcheck.mjs
import assert from 'node:assert';
import { gzipSync } from 'node:zlib';
import { readNbt } from '../src/nbt.js';
import { toGrid, parseState } from '../src/formats.js';
import { convert } from '../src/convert.js';

// --- tiny NBT writer (test only) ---
const T = { byte: 1, short: 2, int: 3, long: 4, string: 8, list: 9, compound: 10, bytes: 7, longs: 12 };
function enc(root) {
  const out = [];
  const u8 = (n) => out.push(n & 0xff);
  const i16 = (n) => { u8(n >> 8); u8(n); };
  const i32 = (n) => { u8(n >> 24); u8(n >> 16); u8(n >> 8); u8(n); };
  const i64 = (b) => { for (let s = 56n; s >= 0n; s -= 8n) u8(Number((BigInt.asUintN(64, b) >> s) & 0xffn)); };
  const str = (s) => { const b = Buffer.from(s); i16(b.length); out.push(...b); };
  function payload([t, v]) {
    if (t === 'byte') u8(v); else if (t === 'short') i16(v); else if (t === 'int') i32(v); else if (t === 'long') i64(v);
    else if (t === 'string') str(v);
    else if (t === 'bytes') { i32(v.length); out.push(...v); }
    else if (t === 'longs') { i32(v.length); v.forEach(i64); }
    else if (t === 'list') { u8(T[v.type]); i32(v.items.length); v.items.forEach((x) => payload([v.type, x])); }
    else if (t === 'compound') { for (const [k, c] of Object.entries(v)) { u8(T[c[0]]); str(k); payload(c); } u8(0); }
  }
  u8(10); str(''); payload(['compound', root]);
  return gzipSync(Buffer.from(out));
}

const BASE = 'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.21.4/assets/minecraft/';
const assets = {
  json: async (p) => { const r = await fetch(BASE + p); return r.ok ? r.json() : null; },
  pixels: async () => ({ data: new Uint8ClampedArray(16 * 16 * 4).fill(255), width: 16, height: 16 }),
  encode: () => 'data:,',
};

// Sponge v2: 3x1x1 -> stone, oak_stairs[facing=east], oak_log[axis=x]; plus a 2nd layer of chest (no geometry)
const states = ['minecraft:air', 'minecraft:stone', 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]', 'minecraft:oak_log[axis=x]', 'minecraft:chest[facing=north,type=single,waterlogged=false]'];
const pal = Object.fromEntries(states.map((s, i) => [s, ['int', i]]));
const schem = enc({ Schematic: ['compound', {
  Version: ['int', 2], Width: ['short', 3], Height: ['short', 2], Length: ['short', 1],
  Palette: ['compound', pal], BlockData: ['bytes', [1, 2, 3, 4, 0, 0]],
}] });
const g = await toGrid(await readNbt(schem));
assert.deepStrictEqual(g.size, [3, 2, 1]);
assert.equal(g.palette[g.data[1]].props.facing, 'east');
const { bbmodel, stats } = await convert(g, assets, { name: 't' });
assert.equal(stats.skipped[0][0], 'minecraft:chest');
const stone = bbmodel.elements.find((e) => e.name === 'stone');
assert.notEqual(stone.faces.east.texture, null, 'stairs are not a full block, so stone must keep its east face');
// log axis=x: end faces (top texture) must be on east/west
const log = bbmodel.elements.find((e) => e.name === 'oak_log');
const texName = (i) => bbmodel.textures[i]?.name;
assert.equal(texName(log.faces.east.texture), 'oak_log_top.png');
assert.equal(texName(log.faces.up.texture), 'oak_log.png');
// stairs facing east: tall back part on the west side? (vanilla stairs face east = step rises toward east)
const stairs = bbmodel.elements.filter((e) => e.name === 'oak_stairs');
assert.equal(stairs.length, 2);

// Flat colour: opaque log collapses into one texture; transparent texture keeps alpha, gets the block average
const flat = await convert(g, assets, { flatColor: true });
const flog = flat.bbmodel.elements.find((e) => e.name === 'oak_log');
const logTex = new Set(Object.values(flog.faces).map((f) => f.texture).filter((t) => t !== null));
assert.equal(logTex.size, 1);
assert.equal(flat.bbmodel.textures[[...logTex][0]].name, 'oak_log_avg.png');
const px = (r, g, b, a) => ({ data: Uint8ClampedArray.from([r, g, b, a, 0, 0, 0, 0]), width: 2, height: 1 });
const { averageColors } = await import('../src/convert.js');
const avg = averageColors([
  { bname: 'minecraft:glass', path: 'block/glass', img: px(100, 100, 100, 255) },
  { bname: 'minecraft:stone', path: 'block/stone', img: { data: Uint8ClampedArray.from([0, 0, 0, 255, 100, 50, 20, 255]), width: 2, height: 1 } },
]);
assert.deepStrictEqual([...avg.finalTex[0].img.data], [100, 100, 100, 255, 100, 100, 100, 0], 'non-cube shapes keep their alpha mask');
const avgGlass = averageColors([{ bname: 'minecraft:glass', path: 'block/glass', img: px(100, 100, 100, 255) }], new Set(['minecraft:glass']));
assert.deepStrictEqual([...avgGlass.finalTex[0].img.data], [100, 100, 100, 128], 'glass becomes one see-through pixel');

// Voxel mode: stone + 2 stairs merge into one box; a torch keeps its own shape
const vGrid = { size: [4, 1, 1], palette: [{ name: 'minecraft:stone', props: {} }, parseState(states[2]), parseState('minecraft:torch')], data: Int32Array.from([0, 1, 1, 2]) };
const vox = (await convert(vGrid, assets, { flatColor: true, voxel: true, fit: false })).bbmodel.elements;
assert.deepStrictEqual(vox.map((e) => e.name), ['stone', 'oak_stairs', 'torch']);
assert.equal(vox[1].to[0] - vox[1].from[0], 32, 'two stairs merged into one 2-block box');

// Greedy meshing: 4x2x3 stone with flat colours = 1 cube; without = one cube per block
const stoneGrid = { size: [4, 2, 3], palette: [{ name: 'minecraft:stone', props: {} }], data: new Int32Array(24) };
assert.equal((await convert(stoneGrid, assets, { flatColor: true })).bbmodel.elements.length, 1);
assert.equal((await convert(stoneGrid, assets, { flatColor: false })).bbmodel.elements.length, 24, 'every block of a 2-high slab touches the surface');
assert.deepStrictEqual([...avg.finalTex[1].img.data], [50, 25, 10, 255], 'stone is averaged into one pixel');

// Litematic: 2x1x1 region with negative size, palette [air, stone, dirt]
const pal3 = ['minecraft:air', 'minecraft:stone', 'minecraft:dirt'].map((n) => ({ Name: ['string', n] }));
const lite = enc({ Regions: ['compound', { r: ['compound', {
  Position: ['compound', { x: ['int', 5], y: ['int', 0], z: ['int', 0] }],
  Size: ['compound', { x: ['int', -2], y: ['int', 1], z: ['int', 1] }],
  BlockStatePalette: ['list', { type: 'compound', items: pal3 }],
  BlockStates: ['longs', [1n | (2n << 2n)]],
}] }] });
const g2 = await toGrid(await readNbt(lite));
assert.deepStrictEqual(g2.size, [2, 1, 1]);
assert.deepStrictEqual([...g2.data].map((i) => g2.palette[i].name), ['minecraft:stone', 'minecraft:dirt']);
// Sample file for manual testing in the browser: a tiny hut
const S = ['minecraft:air', 'minecraft:grass_block[snowy=false]', 'minecraft:oak_planks', 'minecraft:glass',
  'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]',
  'minecraft:oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]',
  'minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]', 'minecraft:torch', 'minecraft:oak_log[axis=y]'];
const W = 5, H = 4, L = 5, data = [];
for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
  const edge = x === 0 || z === 0 || x === W - 1 || z === L - 1, corner = (x === 0 || x === W - 1) && (z === 0 || z === L - 1);
  let b = 0;
  if (y === 0) b = 1;
  else if (y < 3 && corner) b = 8;
  else if (y < 3 && edge) b = y === 2 && x === 2 ? 3 : 2;
  else if (y === 1 && x === 2 && z === 2) b = 7;
  else if (y === 3) b = z < 2 ? 4 : z > 2 ? 5 : 6;
  data.push(b);
}
const fs = await import('node:fs');
fs.writeFileSync(new URL('./sample.schem', import.meta.url), enc({ Schematic: ['compound', {
  Version: ['int', 2], Width: ['short', W], Height: ['short', H], Length: ['short', L],
  Palette: ['compound', Object.fromEntries(S.map((s, i) => [s, ['int', i]]))], BlockData: ['bytes', data],
}] }));
console.log('OK (wrote test/sample.schem)');
