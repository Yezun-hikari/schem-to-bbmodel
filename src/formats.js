// Turns parsed NBT of the supported schematic formats into one common voxel grid:
// { size: [sx, sy, sz], palette: [{ name, props }], data: Int32Array } with index (y * sz + z) * sx + x.

export function parseState(s) {
  const m = /^([^\[]+)(?:\[(.*)\])?$/.exec(s.trim());
  const props = {};
  if (m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); props[k.trim()] = (v ?? '').trim(); }
  return { name: m[1].includes(':') ? m[1] : 'minecraft:' + m[1], props };
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const grid = (sx, sy, sz) => ({ size: [sx, sy, sz], palette: [], data: new Int32Array(sx * sy * sz) });

// Sponge .schem v1/v2/v3 (WorldEdit, FAWE)
function sponge(root) {
  const s = root.Schematic ?? root;
  const w = s.Width & 0xffff, h = s.Height & 0xffff, l = s.Length & 0xffff;
  const pal = s.Blocks?.Palette ?? s.Palette;
  const raw = s.Blocks?.Data ?? s.BlockData;
  if (!pal || !raw) throw new Error('Sponge-Schematic ohne Blockdaten.');
  const g = grid(w, h, l);
  for (const [state, id] of Object.entries(pal)) g.palette[id] = parseState(state);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  let p = 0;
  for (let i = 0; i < w * h * l; i++) {
    let v = 0, shift = 0, b;
    do { b = bytes[p++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    // Sponge index = x + z*W + y*W*L, same layout as our grid
    g.data[i] = v;
  }
  return g;
}

// Litematica .litematic (all regions merged into one grid)
function litematic(root) {
  const regions = Object.values(root.Regions ?? {});
  if (!regions.length) throw new Error('Litematic ohne Regionen.');
  const boxes = regions.map((r) => {
    const sz = [r.Size.x, r.Size.y, r.Size.z];
    const pos = [r.Position.x, r.Position.y, r.Position.z];
    const min = pos.map((v, i) => (sz[i] < 0 ? v + sz[i] + 1 : v));
    return { r, min, dim: sz.map(Math.abs) };
  });
  const lo = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.min[i] + b.dim[i])));
  const g = grid(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const palIndex = new Map();
  for (const { r, min, dim } of boxes) {
    const local = r.BlockStatePalette.map((e) => {
      const key = e.Name + JSON.stringify(e.Properties ?? {});
      if (!palIndex.has(key)) { palIndex.set(key, g.palette.length); g.palette.push({ name: e.Name, props: { ...(e.Properties ?? {}) } }); }
      return palIndex.get(key);
    });
    const bits = BigInt(Math.max(2, Math.ceil(Math.log2(local.length))));
    const mask = (1n << bits) - 1n;
    const arr = new BigUint64Array(r.BlockStates.buffer, r.BlockStates.byteOffset, r.BlockStates.length);
    const [dx, dy, dz] = dim;
    for (let i = 0, n = dx * dy * dz; i < n; i++) {
      const start = BigInt(i) * bits;
      const si = Number(start >> 6n), off = start & 63n;
      let v = arr[si] >> off;
      if (off + bits > 64n) v |= arr[si + 1] << (64n - off);
      const id = local[Number(v & mask)];
      const x = i % dx, z = Math.floor(i / dx) % dz, y = Math.floor(i / (dx * dz));
      const gx = x + min[0] - lo[0], gy = y + min[1] - lo[1], gz = z + min[2] - lo[2];
      g.data[(gy * g.size[2] + gz) * g.size[0] + gx] = id;
    }
  }
  return g;
}

// Vanilla structure block .nbt
function structure(root) {
  const [sx, sy, sz] = root.size.map(num);
  const g = grid(sx, sy, sz);
  const pal = root.palette ?? root.palettes?.[0];
  g.palette = pal.map((e) => ({ name: e.Name, props: { ...(e.Properties ?? {}) } }));
  const air = g.palette.push({ name: 'minecraft:air', props: {} }) - 1;
  g.data.fill(air); // missing positions are "structure void"
  for (const b of root.blocks) {
    const [x, y, z] = b.pos.map(num);
    g.data[(y * sz + z) * sx + x] = b.state;
  }
  return g;
}

// MCEdit / old WorldEdit .schematic (numeric IDs, pre 1.13)
async function legacy(root, loadLegacyMap) {
  const w = root.Width, h = root.Height, l = root.Length;
  const map = await loadLegacyMap();
  const g = grid(w, h, l);
  const palIndex = new Map();
  const ids = root.Blocks, meta = root.Data, add = root.AddBlocks;
  for (let i = 0; i < w * h * l; i++) {
    let id = ids[i] & 0xff;
    if (add) id |= ((add[i >> 1] >> ((i & 1) ? 0 : 4)) & 0xf) << 8;
    const key = id + ':' + (meta[i] & 0xf);
    if (!palIndex.has(key)) {
      const s = map[key] ?? map[id + ':0'] ?? 'minecraft:air';
      palIndex.set(key, g.palette.push(parseState(s)) - 1);
    }
    g.data[i] = palIndex.get(key); // legacy index (y*L + z)*W + x matches our grid
  }
  return g;
}

export async function toGrid(nbt, loadLegacyMap) {
  const v = nbt.value;
  if (v.Regions) return litematic(v);
  if (v.palette || v.palettes) return structure(v);
  if (v.Blocks instanceof Int8Array && v.Data instanceof Int8Array) return legacy(v, loadLegacyMap);
  if (v.Schematic || v.Palette || v.BlockData) return sponge(v);
  throw new Error('Unbekanntes Schematic-Format.');
}

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);

// Lossy: every k×k×k cell becomes its most frequent non-air block, or air if less than `minFill` of it is solid.
// A low threshold keeps 1-block walls and shells that a majority vote would erase.
export function downsample(grid, k, minFill = 0.25) {
  if (k <= 1) return grid;
  const [sx, sy, sz] = grid.size, n = grid.size.map((s) => Math.ceil(s / k)), palette = [...grid.palette];
  let air = palette.findIndex((p) => AIR.has(p.name));
  if (air < 0) air = palette.push({ name: 'minecraft:air', props: {} }) - 1;
  const data = new Int32Array(n[0] * n[1] * n[2]).fill(air), count = new Map();
  for (let Y = 0; Y < n[1]; Y++) for (let Z = 0; Z < n[2]; Z++) for (let X = 0; X < n[0]; X++) {
    count.clear();
    let total = 0, solid = 0, best = air, bestN = 0;
    for (let y = Y * k; y < Math.min(sy, Y * k + k); y++) for (let z = Z * k; z < Math.min(sz, Z * k + k); z++) for (let x = X * k; x < Math.min(sx, X * k + k); x++) {
      const b = grid.data[(y * sz + z) * sx + x];
      total++;
      if (AIR.has(palette[b].name)) continue;
      solid++;
      const c = (count.get(b) ?? 0) + 1;
      count.set(b, c);
      if (c > bestN) { best = b; bestN = c; }
    }
    if (solid >= minFill * total) data[(Y * n[2] + Z) * n[0] + X] = best;
  }
  return { ...grid, size: n, palette, data };
}
