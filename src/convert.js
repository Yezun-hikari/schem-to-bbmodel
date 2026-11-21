// Voxel grid + vanilla assets (blockstates/models/textures) -> Blockbench .bbmodel (Java Block/Item format).
// `assets` = { json(path) -> object|null, pixels(path, tint) -> { data: RGBA bytes, width, height }|null,
//              encode({ data, width, height }) -> data URL }, paths relative to assets/minecraft/.

const DIRS = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const FACE_NAMES = Object.keys(DIRS);
// Texture u/v direction in world space for each face at rotation 0 (matches Minecraft's default UVs)
const FACE_UV_AXES = {
  down: [[1, 0, 0], [0, 0, -1]], up: [[1, 0, 0], [0, 0, 1]],
  north: [[-1, 0, 0], [0, -1, 0]], south: [[1, 0, 0], [0, -1, 0]],
  west: [[0, 0, 1], [0, -1, 0]], east: [[0, 0, -1], [0, -1, 0]],
};
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);
const NOT_OCCLUDING = /glass|leaves|ice$|slime|honey_block|barrier|spawner|scaffolding|beacon|mangrove_roots/;

// Default biome colours (plains) for faces with tintindex
function tintFor(name) {
  const n = name.replace('minecraft:', '');
  if (n === 'birch_leaves') return 0x80a755;
  if (n === 'spruce_leaves') return 0x619961;
  if (n === 'lily_pad') return 0x208030;
  if (/leaves$|^vine$/.test(n)) return 0x77ab2f;
  if (/grass|fern|sugar_cane/.test(n)) return 0x91bd59;
  return null;
}

const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const mul = (m, v) => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
const mmul = (a, b) => a.map((row) => [0, 1, 2].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c]));
const neg = (v) => v.map((x) => -x);
const dirName = (v) => FACE_NAMES.find((f) => eq(DIRS[f], v));

// Blockstate rotation as Minecraft applies it: Ry(-y) * Rx(-x), angles in multiples of 90
function rotMatrix(x = 0, y = 0) {
  const c = (d) => Math.round(Math.cos((d * Math.PI) / 180)), s = (d) => Math.round(Math.sin((d * Math.PI) / 180));
  const rx = [[1, 0, 0], [0, c(-x), -s(-x)], [0, s(-x), c(-x)]];
  const ry = [[c(-y), 0, s(-y)], [0, 1, 0], [-s(-y), 0, c(-y)]];
  return mmul(ry, rx);
}

function defaultUv(face, f, t) {
  switch (face) {
    case 'down': return [f[0], 16 - t[2], t[0], 16 - f[2]];
    case 'up': return [f[0], f[2], t[0], t[2]];
    case 'north': return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 'south': return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 'west': return [f[2], 16 - t[1], t[2], 16 - f[1]];
    case 'east': return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
  }
}

// One clockwise 90° texture rotation: U' = V, V' = -U
const rotUv = ([u, v], steps) => { for (let i = 0; i < steps; i++) [u, v] = [v, neg(u)]; return [u, v]; };

// Texture rotation needed on face `target` so it shows the same mapping as the transformed source axes
function matchRotation(target, [u, v]) {
  for (let r = 0; r < 4; r++) {
    const [cu, cv] = rotUv(FACE_UV_AXES[target], r);
    if (eq(cu, u) && eq(cv, v)) return r * 90;
  }
  return 0;
}

const stripNs = (s) => s.replace(/^minecraft:/, '');
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

function matchesWhen(when, props) {
  if (!when) return true;
  if (when.OR) return when.OR.some((w) => matchesWhen(w, props));
  if (when.AND) return when.AND.every((w) => matchesWhen(w, props));
  return Object.entries(when).every(([k, v]) => String(v).split('|').includes(String(props[k])));
}

function matchesVariant(key, props) {
  if (!key) return true;
  return key.split(',').every((kv) => { const [k, v] = kv.split('='); return String(props[k]) === v; });
}

export async function convert(grid, assets, opts = {}) {
  const { fit = true, bakeTint = true, flatColor = false, voxel = false, javaBlockVersion = '1.9.0', name = 'model' } = opts;
  const modelCache = new Map();

  function loadModel(ref) {
    if (!modelCache.has(ref)) modelCache.set(ref, (async () => {
      let textures = {}, elements = null, cur = ref;
      for (let depth = 0; cur && depth < 20; depth++) {
        if (cur.startsWith('builtin/') || (cur.includes(':') && !cur.startsWith('minecraft:'))) break;
        const m = await assets.json(`models/${stripNs(cur)}.json`);
        if (!m) break;
        textures = { ...(m.textures ?? {}), ...textures };
        if (!elements && m.elements) elements = m.elements;
        cur = m.parent;
      }
      const resolve = (v) => { for (let i = 0; i < 10 && v?.startsWith('#'); i++) v = textures[v.slice(1)]; return v && !v.startsWith('#') ? stripNs(v) : null; };
      return { elements: elements ?? [], resolve };
    })());
    return modelCache.get(ref);
  }

  // Returns list of element descriptions in block-local coordinates, or null if the block has no geometry
  async function resolveState({ name: bname, props }) {
    if (AIR.has(bname) || !bname.startsWith('minecraft:')) return null;
    const bs = await assets.json(`blockstates/${stripNs(bname)}.json`);
    if (!bs) return null;
    let applies = [];
    if (bs.variants) {
      const hit = Object.entries(bs.variants).find(([k]) => matchesVariant(k, props));
      if (hit) applies.push(hit[1]);
    } else if (bs.multipart) {
      applies = bs.multipart.filter((p) => matchesWhen(p.when, props)).map((p) => p.apply);
    }
    const out = [];
    for (let a of applies) {
      if (Array.isArray(a)) a = a[0]; // weighted random variants: take the first
      const model = await loadModel(a.model);
      const M = rotMatrix(a.x, a.y);
      const tp = (p) => mul(M, p.map((c) => c - 8)).map((c) => c + 8);
      for (const el of model.elements) {
        const p1 = tp(el.from), p2 = tp(el.to);
        const from = [0, 1, 2].map((i) => Math.min(p1[i], p2[i])), to = [0, 1, 2].map((i) => Math.max(p1[i], p2[i]));
        let rotation = null;
        if (el.rotation && el.rotation.angle) {
          const axis = mul(M, DIRS[{ x: 'east', y: 'up', z: 'south' }[el.rotation.axis]]);
          const ai = axis.findIndex((c) => c !== 0);
          rotation = { axis: ai, angle: el.rotation.angle * axis[ai], origin: tp(el.rotation.origin), rescale: !!el.rotation.rescale };
        }
        const faces = {};
        for (const [fname, f] of Object.entries(el.faces ?? {})) {
          const target = dirName(mul(M, DIRS[fname]));
          const r0 = ((f.rotation ?? 0) / 90) | 0;
          let uv, rot;
          if (a.uvlock) { uv = defaultUv(target, from, to); rot = r0 * 90; }
          else {
            uv = f.uv ?? defaultUv(fname, el.from, el.to);
            rot = matchRotation(target, rotUv(FACE_UV_AXES[fname], r0).map((ax) => mul(M, ax)));
          }
          faces[target] = {
            uv, rotation: rot, texture: model.resolve(f.texture), tint: f.tintindex ?? -1,
            cullface: f.cullface ? dirName(mul(M, DIRS[f.cullface])) : null,
          };
        }
        out.push({ from, to, rotation, faces, shade: el.shade !== false });
      }
    }
    return out.length ? out : null;
  }

  let resolved = await Promise.all(grid.palette.map((s) => (s ? resolveState(s) : null)));
  // With one colour per block, overlay elements (e.g. grass_block side overlay) only duplicate the cube below
  if (flatColor) resolved = resolved.map((els) => els && els.filter((e, i) => !els.slice(0, i).some((o) => eq(o.from, e.from) && eq(o.to, e.to))));
  // Voxel mode: blocks filling at least half their space (stairs, slabs, …) become full cubes so they can merge.
  // Thin shapes (torches, fences, doors, flowers) keep their geometry.
  if (voxel && flatColor) resolved = resolved.map((els) => {
    if (!els) return els;
    const vol = els.reduce((s, e) => s + [0, 1, 2].reduce((p, i) => (p * (e.to[i] - e.from[i])) / 16, 1), 0);
    const f = els.flatMap((e) => Object.values(e.faces)).find((x) => x.texture);
    if (vol < 0.5 || !f) return els;
    const faces = Object.fromEntries(FACE_NAMES.map((n) => [n, { texture: f.texture, tint: f.tint, uv: [0, 0, 16, 16], rotation: 0, cullface: n }]));
    return [{ from: [0, 0, 0], to: [16, 16, 16], rotation: null, faces, shade: true }];
  });
  const fullCube = resolved.map((els) => !!els && els.length === 1 && !els[0].rotation &&
    eq(els[0].from, [0, 0, 0]) && eq(els[0].to, [16, 16, 16]) && Object.keys(els[0].faces).length === 6);
  const occluding = fullCube.map((f, i) => f && !NOT_OCCLUDING.test(grid.palette[i].name));
  // Blocks whose transparent textures become one uniform see-through colour (glass, leaves, ice, panes)
  const uniformAlpha = new Set(grid.palette.filter((s, i) => s && (fullCube[i] || /glass/.test(s.name))).map((s) => s.name));

  const [sx, sy, sz] = grid.size;
  const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? -1 : grid.data[(y * sz + z) * sx + x]);

  // Trim to the bounding box of visible blocks
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    if (!resolved[at(x, y, z)]) continue;
    [x, y, z].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v + 1); });
  }
  if (lo[0] === Infinity) throw new Error('Keine darstellbaren Blöcke gefunden.');
  const dim = [0, 1, 2].map((i) => hi[i] - lo[i]);
  const scale = fit ? Math.min(1, 3 / Math.max(...dim)) : 1; // Java models may span -16..32 = 3 blocks
  const off = dim.map((d) => 8 - (d * 16 * scale) / 2);
  const P = (v, i, b) => Math.round(((b - lo[i]) * 16 * scale + v * scale + off[i]) * 10000) / 10000;

  const textures = [], texIndex = new Map();
  const texFor = (path, bname, tint) => {
    if (!path) return null;
    const color = bakeTint && tint >= 0 ? tintFor(bname) : null;
    const key = path + '|' + color + (flatColor ? '|' + bname : '');
    if (!texIndex.has(key)) { texIndex.set(key, textures.length); textures.push({ path, color, bname }); }
    return texIndex.get(key);
  };

  const elements = [], groups = new Map(), skipped = new Map();
  // `hidden(fname, f)` decides per face whether it is culled; `base` is the block position of the element's origin
  function addElement(bname, el, base, hidden) {
    const short = stripNs(bname);
    const faces = {};
    let visible = 0;
    for (const fname of FACE_NAMES) {
      const f = el.faces[fname];
      if (!f || hidden(fname, f)) { faces[fname] = { uv: [0, 0, 0, 0], texture: null }; continue; }
      visible++;
      const tex = texFor(f.texture, bname, f.tint);
      const baked = bakeTint && f.tint >= 0 && tintFor(bname) !== null;
      faces[fname] = { uv: f.uv, texture: tex, ...(f.rotation ? { rotation: f.rotation } : {}), ...(f.cullface ? { cullface: f.cullface } : {}), tint: baked ? -1 : f.tint };
    }
    if (!visible) return;
    const rot = [0, 0, 0];
    if (el.rotation) rot[el.rotation.axis] = el.rotation.angle;
    const uuid = crypto.randomUUID();
    elements.push({
      name: short, box_uv: false, rescale: el.rotation?.rescale ?? false, locked: false, render_order: 'default',
      allow_mirror_modeling: true, shade: el.shade,
      from: el.from.map((v, i) => P(v, i, base[i])), to: el.to.map((v, i) => P(v, i, base[i])),
      autouv: 0, color: groups.size % 8,
      origin: (el.rotation?.origin ?? [8, 8, 8]).map((v, i) => P(v, i, base[i])),
      rotation: rot, faces, type: 'cube', uuid,
    });
    if (!groups.has(short)) groups.set(short, []);
    groups.get(short).push(uuid);
  }

  // With one colour per block, runs of the same full-cube block are merged into large boxes (greedy meshing).
  // This is what keeps Blockbench responsive: a solid wall becomes one cube instead of hundreds.
  const done = new Uint8Array(sx * sy * sz), cover = new Uint16Array(sx * sy * sz), boxes = [];
  const forCells = (a, b, fn) => { for (let y = a[1]; y < b[1]; y++) for (let z = a[2]; z < b[2]; z++) for (let x = a[0]; x < b[0]; x++) fn((y * sz + z) * sx + x); };
  const vol = ({ a, b }) => (b[0] - a[0]) * (b[1] - a[1]) * (b[2] - a[2]);
  const nameAt = (x, y, z) => { const id = at(x, y, z); return id >= 0 && fullCube[id] ? grid.palette[id].name : null; };
  // Flood from outside through everything see-through: what the flood never touches (sealed cavities included)
  // can never be seen. Cells with no flooded neighbour may be swallowed by any box and need no box themselves.
  const reach = new Uint8Array(sx * sy * sz), stack = [];
  const visit = (x, y, z) => {
    const i = (y * sz + z) * sx + x;
    if (!reach[i] && !occluding[grid.data[i]]) { reach[i] = 1; stack.push(x, y, z); }
  };
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) visit(x, y, z);
  }
  while (stack.length) {
    const z = stack.pop(), y = stack.pop(), x = stack.pop();
    for (const [dx, dy, dz] of Object.values(DIRS)) {
      const a = x + dx, b = y + dy, c = z + dz;
      if (a >= 0 && b >= 0 && c >= 0 && a < sx && b < sy && c < sz) visit(a, b, c);
    }
  }
  // Out of bounds counts as flooded (open air around the build)
  const seen = (x, y, z) => at(x, y, z) < 0 || !!reach[(y * sz + z) * sx + x];
  const blocks = (x, y, z) => !seen(x, y, z) || !!occluding[at(x, y, z)];
  const sealed = (x, y, z) => !seen(x, y, z) && FACE_NAMES.every((f) => !seen(x + DIRS[f][0], y + DIRS[f][1], z + DIRS[f][2]));
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) if (sealed(x, y, z)) done[(y * sz + z) * sx + x] = 2;
  // Opaque boxes of one colour may overlap each other; see-through ones must not (alpha would stack)
  const free = (x, y, z, n, opaque) => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return false;
    const d = done[(y * sz + z) * sx + x];
    return d === 2 || (nameAt(x, y, z) === n && (!d || opaque));
  };

  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    if (done[(y * sz + z) * sx + x]) continue;
    const id = at(x, y, z);
    const els = resolved[id];
    const bname = grid.palette[id]?.name;
    if (!els) { if (bname && !AIR.has(bname)) skipped.set(bname, (skipped.get(bname) ?? 0) + 1); continue; }

    if (!flatColor || !fullCube[id]) {
      for (const el of els) addElement(bname, el, [x, y, z], (_, f) => {
        const n = f.cullface && DIRS[f.cullface];
        return n && blocks(x + n[0], y + n[1], z + n[2]);
      });
      continue;
    }

    // Grow the box along each axis in turn; try every axis order and keep the one covering most new cells
    const opaque = occluding[id];
    let best = null;
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const a = [x, y, z], b = [x + 1, y + 1, z + 1];
      const slabFree = (ax, v) => {
        const p = [...a], q = [...b]; p[ax] = v; q[ax] = v + 1;
        for (let yy = p[1]; yy < q[1]; yy++) for (let zz = p[2]; zz < q[2]; zz++) for (let xx = p[0]; xx < q[0]; xx++) if (!free(xx, yy, zz, bname, opaque)) return false;
        return true;
      };
      for (const ax of order) { while (slabFree(ax, a[ax] - 1)) a[ax]--; while (slabFree(ax, b[ax])) b[ax]++; }
      let gain = 0;
      forCells(a, b, (i) => { gain += !done[i]; });
      if (!best || gain > best.gain) best = { a, b, gain };
    }
    boxes.push({ bname, els, a: best.a, b: best.b });
    forCells(best.a, best.b, (i) => { done[i] ||= 1; cover[i]++; });
  }

  // Overlap can leave boxes whose every visible cell another box also covers: drop those, smallest first
  const kept = boxes.sort((p, q) => vol(p) - vol(q)).filter(({ a, b }) => {
    let needed = false;
    forCells(a, b, (i) => { needed ||= done[i] === 1 && cover[i] === 1; });
    if (!needed) forCells(a, b, (i) => cover[i]--);
    return needed;
  });
  for (const { bname, els, a: [x0, y0, z0], b: [x1, y1, z1] } of kept) {
    // A face is hidden only if every neighbour cell across it occludes
    const box = { from: [0, 0, 0], to: [(x1 - x0) * 16, (y1 - y0) * 16, (z1 - z0) * 16], rotation: null, shade: els[0].shade, faces: {} };
    for (const [fname, f] of Object.entries(els[0].faces)) box.faces[fname] = { texture: f.texture, tint: f.tint, uv: [0, 0, 16, 16] };
    addElement(bname, box, [x0, y0, z0], (fname) => {
      const [dx, dy, dz] = DIRS[fname];
      const xs = dx ? [dx > 0 ? x1 : x0 - 1] : range(x0, x1);
      const ys = dy ? [dy > 0 ? y1 : y0 - 1] : range(y0, y1);
      const zs = dz ? [dz > 0 ? z1 : z0 - 1] : range(z0, z1);
      for (const a of xs) for (const b of ys) for (const c of zs) if (!blocks(a, b, c)) return false;
      return true;
    });
  }

  const pixels = await Promise.all(textures.map((t) => assets.pixels(t.path, t.color)));
  const missingTextures = textures.filter((_, i) => !pixels[i]).map((t) => t.path);
  // remap[i] = final texture index for registry entry i
  let finalTex = textures.map((t, i) => ({ ...t, img: pixels[i] })), remap = textures.map((_, i) => i);
  if (flatColor) ({ finalTex, remap } = averageColors(finalTex, uniformAlpha));
  const texData = finalTex.map((t) => t.img && { source: assets.encode(t.img), width: t.img.width, height: t.img.height });
  for (const el of elements) for (const f of Object.values(el.faces)) if (f.texture !== null) f.texture = remap[f.texture];

  const groupList = [...groups.keys()].map((g) => ({
    name: g, origin: [8, 8, 8], color: 0, uuid: crypto.randomUUID(), export: true, mirror_uv: false,
    isOpen: false, locked: false, visibility: true, autouv: 0,
  }));

  const bbmodel = {
    meta: { format_version: '5.0', model_format: 'java_block', box_uv: false },
    name, model_identifier: '', parent: '', ambientocclusion: true, front_gui_light: false,
    visible_box: [1, 1, 0], variable_placeholders: '', variable_placeholder_buttons: [], unhandled_root_fields: {},
    java_block_version: javaBlockVersion,
    resolution: { width: 16, height: 16 },
    elements,
    groups: groupList,
    outliner: groupList.map((g) => ({ uuid: g.uuid, isOpen: false, children: groups.get(g.name) })),
    textures: finalTex.map((t, i) => {
      const d = texData[i];
      const parts = t.path.split('/');
      const base = t.avgName ?? parts.pop() + (t.color !== null ? '_tinted' : '');
      return {
        path: '', name: base + '.png', folder: parts.join('/'), namespace: 'minecraft', id: String(i), group: '',
        width: d?.width ?? 16, height: d?.height ?? 16, uv_width: 16, uv_height: 16, particle: false,
        use_as_default: false, layers_enabled: false, sync_to_project: '', render_mode: 'default', render_sides: 'auto',
        pbr_channel: 'color', frame_time: 1, frame_order_type: 'loop', frame_order: '', frame_interpolate: false,
        visible: true, internal: true, saved: false, uuid: crypto.randomUUID(), ...(d ? { source: d.source } : {}),
      };
    }),
    display: {},
  };
  return { bbmodel, stats: { cubes: elements.length, size: dim, scale, skipped: [...skipped.entries()], missingTextures } };
}

// Replaces every texture by its block's average colour (alpha-weighted over all of the block's textures).
// Blocks in `uniformAlpha` (cube-like: glass, leaves, ice, panes) get one colour with the texture's average alpha,
// so they stay see-through without showing the texture's pattern. Other shapes (torches, flowers) keep their
// alpha mask, otherwise their silhouette would be lost. Identical results of one block share one texture.
export function averageColors(entries, uniformAlpha = new Set()) {
  const sums = new Map();
  for (const t of entries) {
    if (!t.img) continue;
    const s = sums.get(t.bname) ?? [0, 0, 0, 0];
    const d = t.img.data;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; s[0] += d[i] * a; s[1] += d[i + 1] * a; s[2] += d[i + 2] * a; s[3] += a; }
    sums.set(t.bname, s);
  }
  const finalTex = [], solidIndex = new Map();
  const remap = entries.map((t) => {
    const short = stripNs(t.bname);
    if (!t.img) return finalTex.push({ ...t, avgName: short + '_avg' }) - 1;
    const s = sums.get(t.bname);
    const rgb = s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]].map(Math.round) : [0, 0, 0];
    const src = t.img.data;
    let alphaSum = 0;
    for (let i = 3; i < src.length; i += 4) alphaSum += src[i];
    const avgAlpha = Math.round(alphaSum / (src.length / 4));
    const uniform = avgAlpha === 255 || uniformAlpha.has(t.bname);
    const key = t.bname + '|' + avgAlpha;
    if (uniform && solidIndex.has(key)) return solidIndex.get(key);
    // A uniform colour needs only 1 pixel: UVs stay in 0..16 space (uv_width), whatever the image size
    const data = uniform ? Uint8ClampedArray.from([...rgb, avgAlpha]) : new Uint8ClampedArray(src.length);
    if (!uniform) for (let i = 0; i < src.length; i += 4) { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = src[i + 3]; }
    const idx = finalTex.push({
      ...t, img: uniform ? { data, width: 1, height: 1 } : { data, width: t.img.width, height: t.img.height },
      avgName: avgAlpha === 255 ? short + '_avg' : short + '_' + t.path.split('/').pop() + '_avg',
    }) - 1;
    if (uniform) solidIndex.set(key, idx);
    return idx;
  });
  return { finalTex, remap };
}
