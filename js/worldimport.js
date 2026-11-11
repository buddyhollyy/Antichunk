// Reads a player's saved Luanti world (map.sqlite) and draws every explored
// column of the Overworld, the Nether and the End as map tiles.  Runs in its own Web
// Worker, so the page stays responsive.  The file never leaves the computer:
// it is read here, piece by piece, straight from the disk.
//
// map.sqlite is an SQLite 3 database with one table, `blocks`, holding one
// row per 16x16x16 mapblock (Luanti doc/world_format.md).  Since Luanti
// 5.12.0 the table has columns x, y, z, data; before that it had pos, data
// with pos = z*0x1000000 + y*0x1000 + x.  Rather than load all of SQLite and
// the whole file into memory, this reads the database's b-tree pages
// directly, following the file format at https://www.sqlite.org/fileformat2.html.
//
// Each mapblock is serialized as described in luanti's world_format.md. 
// Since map format version 29 (Luanti 5.5) everything after the version 
// byte is one zstd frame; inside are the node names used in the block and, 
// for each of the 4096 nodes, a 16-bit content id (param0), param1 and param2.
//
// Uses NODE_COLORS (node-colors.js) and ZSTD_WASM_B64 (zstd-wasm.js).
'use strict';

const TILE = 256;                 // nodes per side of one output tile
const OVERWORLD_MIN_BY = -64;     // mapblocks at y >= this are Overworld (y >= -1024)
// The Nether and the End are far below, as layers of the same world.
// Mineclonia's heights (mods/CORE/mcl_init/init.lua, worlds not made with
// its singlenode generator): the Nether runs from y -29067 to -28939, with
// 5 layers of bedrock at the bottom and top; the End starts at y -27073 and
// reaches up to y -2128 (2000 below the Overworld's bottom at -128).
const NETHER_MIN = -29067, NETHER_MAX = NETHER_MIN + 128;
const END_MIN = -27073, END_MAX = -128 - 2000;
const by0 = (y) => Math.floor(y / 16);
function dimOf(by) {
  if (by >= OVERWORLD_MIN_BY) return 'overworld';
  if (by >= by0(NETHER_MIN) && by <= by0(NETHER_MAX)) return 'nether';
  if (by >= by0(END_MIN) && by <= by0(END_MAX)) return 'end';
  return null;
}
// In the Nether the top view would show only its bedrock roof.  Instead,
// each column shows the highest block below the roof that the Nether's own
// terrain never makes: something a player built, or part of a fortress,
// bastion or ruined portal.  Where there is none, it shows the first ground
// below the roof that has at least NETHER_GAP open nodes (air, or things too
// small to show) above it: a space a player could stand in.
const NETHER_GAP = 2;
// What Mineclonia's Nether terrain is made of (mcl_biomes/init.lua: Nether
// biomes, ores and decorations, and the huge fungus trees; mcl_mapgen_core
// adds bedrock, and a layer of plain stone shows up at a mapchunk edge).
const NETHER_NATURAL = new Set(['mcl_core:bedrock', 'mcl_core:stone', 'mcl_core:gravel',
  'mcl_nether:netherrack', 'mcl_nether:soul_sand', 'mcl_nether:magma', 'mcl_nether:glowstone', 'mcl_nether:quartz_ore',
  'mcl_nether:ancient_debris', 'mcl_nether:nether_lava_source', 'mcl_nether:nether_lava_flowing', 'mcl_nether:nether_wart_block',
  'mcl_blackstone:basalt', 'mcl_blackstone:blackstone', 'mcl_blackstone:soul_soil', 'mcl_blackstone:nether_gold',
  'mcl_blackstone:soul_fire', 'mcl_fire:fire', 'mcl_fire:eternal_fire',
  'mcl_crimson:crimson_nylium', 'mcl_crimson:warped_nylium', 'mcl_crimson:warped_wart_block', 'mcl_crimson:shroomlight',
  'mcl_crimson:crimson_fungus', 'mcl_crimson:warped_fungus', 'mcl_crimson:crimson_roots', 'mcl_crimson:warped_roots',
  'mcl_crimson:nether_sprouts', 'mcl_crimson:weeping_vines', 'mcl_crimson:twisting_vines',
  'mcl_trees:tree_crimson', 'mcl_trees:tree_warped']);

// ------------------------------------------------------------ zstd
let zx = null, heap = null, heapView = null;
function zstdInit() {
  const bin = atob(ZSTD_WASM_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const refresh = () => { heap = new Uint8Array(zx.memory.buffer); heapView = new DataView(zx.memory.buffer); };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes),
    { env: { emscripten_notify_memory_growth: () => refresh() } });
  zx = inst.exports;
  refresh();
}
// Fixed buffers inside the decoder's memory, grown when needed.
let inPtr = 0, inCap = 0, outPtr = 0;
const OUT_CAP = 1 << 18;          // 256 KiB is enough for nearly every block
function zstdDecode(src) {
  if (src.length > inCap) {
    if (inPtr) zx.free(inPtr);
    inCap = Math.max(src.length, 1 << 16); inPtr = zx.malloc(inCap);
  }
  if (!outPtr) outPtr = zx.malloc(OUT_CAP);
  heap = new Uint8Array(zx.memory.buffer);   // malloc may have grown memory
  heap.set(src, inPtr);
  const r = zx.ZSTD_decompress(outPtr, OUT_CAP, inPtr, src.length) >>> 0;
  if (r <= OUT_CAP) return heap.subarray(outPtr, outPtr + r);
  return zstdStream(src.length);              // bigger than OUT_CAP (or an error)
}
// Streaming fallback for very large blocks (lots of node metadata).
function zstdStream(n) {
  const outSize = zx.ZSTD_DStreamOutSize(), buf = zx.malloc(outSize);
  const ib = zx.malloc(12), ob = zx.malloc(12), dctx = zx.ZSTD_createDCtx();
  heapView = new DataView(zx.memory.buffer);
  heapView.setUint32(ib, inPtr, true); heapView.setUint32(ib + 4, n, true); heapView.setUint32(ib + 8, 0, true);
  const parts = []; let total = 0, ret = 1;
  try {
    while (true) {
      heapView = new DataView(zx.memory.buffer);
      heapView.setUint32(ob, buf, true); heapView.setUint32(ob + 4, outSize, true); heapView.setUint32(ob + 8, 0, true);
      ret = zx.ZSTD_decompressStream(dctx, ob, ib) >>> 0;
      if (ret > 0x7fffffff) throw new Error('zstd error');
      heapView = new DataView(zx.memory.buffer);
      const got = heapView.getUint32(ob + 8, true);
      parts.push(new Uint8Array(zx.memory.buffer).slice(buf, buf + got)); total += got;
      const used = heapView.getUint32(ib + 8, true);
      if (ret === 0 || (used >= n && got < outSize)) break;
    }
  } finally { zx.ZSTD_freeDCtx(dctx); zx.free(buf); zx.free(ib); zx.free(ob); }
  if (ret !== 0) throw new Error('zstd frame incomplete');
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ------------------------------------------------------------ file access
let file = null, reader = null;
function readBytes(off, len) {
  return new Uint8Array(reader.readAsArrayBuffer(file.slice(off, off + len)));
}

// ------------------------------------------------------------ SQLite
let pageSize = 0, usable = 0, nPages = 0;
const pageCache = new Map();      // a few pages kept for random reads
function page(n) {
  let p = pageCache.get(n);
  if (!p) {
    if (n < 1 || n > nPages) throw new Error('bad page ' + n);
    p = readBytes((n - 1) * pageSize, pageSize);
    if (pageCache.size > 256) pageCache.clear();
    pageCache.set(n, p);
  }
  return p;
}
// Varint at b[o]: returns [value, length].  Values here fit in a double.
function varint(b, o) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const c = b[o + i];
    v = v * 128 + (c & 0x7f);
    if (!(c & 0x80)) return [v, i + 1];
  }
  return [v * 256 + b[o + 8], 9];
}
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const hdrOff = (n) => (n === 1 ? 100 : 0);
// Bytes of a table-leaf payload of size P kept on the page itself.
function localSize(P) {
  const X = usable - 35;
  if (P <= X) return P;
  const M = Math.floor((usable - 12) * 32 / 255) - 23;
  const K = M + ((P - M) % (usable - 4));
  return K <= X ? K : M;
}
// Full payload of the cell at offset o of table-leaf page b.
function cellPayload(b, o) {
  const [P, l1] = varint(b, o);
  const [, l2] = varint(b, o + l1);
  const start = o + l1 + l2, L = localSize(P);
  if (L === P) return b.subarray(start, start + P);
  const out = new Uint8Array(P);
  out.set(b.subarray(start, start + L));
  let got = L, next = u32(b, start + L);
  while (got < P && next) {
    const ov = page(next);
    const n = Math.min(P - got, usable - 4);
    out.set(ov.subarray(4, 4 + n), got); got += n;
    next = u32(ov, 0);
  }
  if (got < P) throw new Error('overflow chain too short');
  return out;
}
// Decode a record; returns an array of values (numbers, or
// {blob:[start,end]} / strings).  Only what this file needs.
function record(p) {
  const [hs, l] = varint(p, 0);
  const types = [];
  for (let o = l; o < hs;) { const [t, n] = varint(p, o); types.push(t); o += n; }
  const vals = []; let o = hs;
  for (const t of types) {
    if (t === 0) vals.push(null);
    else if (t >= 1 && t <= 6) {
      const n = [0, 1, 2, 3, 4, 6, 8][t];
      let v = p[o] >= 128 ? p[o] - 256 : p[o];   // big-endian two's complement
      for (let i = 1; i < n; i++) v = v * 256 + p[o + i];
      vals.push(v); o += n;
    } else if (t === 7) { vals.push(new DataView(p.buffer, p.byteOffset + o, 8).getFloat64(0)); o += 8; }
    else if (t === 8) vals.push(0);
    else if (t === 9) vals.push(1);
    else if (t >= 12 && t % 2 === 0) { const n = (t - 12) / 2; vals.push({ blob: [o, o + n] }); o += n; }
    else if (t >= 13) { const n = (t - 13) / 2; vals.push(new TextDecoder().decode(p.subarray(o, o + n))); o += n; }
    else throw new Error('bad record');
  }
  return vals;
}
// Visit every cell (page buffer, cell offset, page number) of the given
// table-leaf pages.  Only used for the small schema table.
function eachCell(pages, fn) {
  for (const n of pages) {
    const b = page(n), h = hdrOff(n), cells = u16(b, h + 3);
    for (let c = 0; c < cells; c++) fn(b, u16(b, h + 8 + 2 * c), n);
  }
}
// Leaf pages of the table b-tree rooted at `root`.  `children` gives the
// child pages of interior pages already read; others are read here.
function leafPages(root, children) {
  const out = [], stack = [root];
  while (stack.length) {
    const n = stack.pop();
    let kids = children && children.get(n);
    // With `children` given, every interior page is in it: the rest are leaves.
    if (children && !kids) { out.push(n); continue; }
    if (!kids) {
      const b = page(n), h = hdrOff(n), type = b[h];
      if (type === 13) { out.push(n); continue; }
      if (type !== 5) throw new Error('unexpected page type ' + type + ' on page ' + n);
      kids = interiorKids(b, h);
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}
function interiorKids(b, h) {
  const cells = u16(b, h + 3), kids = new Int32Array(cells + 1);
  for (let i = 0; i < cells; i++) kids[i] = u32(b, u16(b, h + 12 + 2 * i));
  kids[cells] = u32(b, h + 8);
  return kids;
}
// Read the whole file front to back in big pieces (reading it this way is
// fast; jumping around one page at a time is ~1000 times slower), calling
// fn(pageBuffer, pageNumber) for each page.
function scanPages(fn, progress) {
  const per = Math.max(1, Math.floor((8 << 20) / pageSize));
  for (let first = 1; first <= nPages; first += per) {
    const cnt = Math.min(per, nPages - first + 1);
    const chunk = readBytes((first - 1) * pageSize, cnt * pageSize);
    for (let k = 0; k < cnt; k++) fn(chunk.subarray(k * pageSize, (k + 1) * pageSize), first + k);
    if (progress) progress((first + cnt - 1) / nPages);
  }
}

// ------------------------------------------------------------ colors
const SKIP_EXACT = new Set(['air', 'ignore', 'mcl_core:void', 'mcl_core:realm_barrier', 'mcl_core:barrier',
  'mcl_core:structblock_void', 'mcl_lights:light', 'unknown']);
// Small plants and thin things: show the ground under them instead.
const SKIP_PREFIX = ['mcl_flowers:', 'mcl_core:vine', 'mcl_mushrooms:mushroom_', 'mcl_core:deadbush',
  'mcl_torches:', 'mcl_redstone:wire', 'mcl_redstone_torch:', 'mcl_lights:', 'mcl_ocean:seagrass', 'mcl_ocean:kelp',
  'mcl_core:cobweb', 'mcl_signs:', 'mcl_buttons:', 'mcl_levers:', 'mcl_lanterns:chain', 'mcl_farming:wheat_',
  'mcl_farming:potato_', 'mcl_farming:carrot_', 'mcl_farming:beetroot_', 'mcl_sus_nodes:', 'mcl_mobspawners:'];
const KEEP = ['mcl_flowers:waterlily'];
const skipName = (nm) => SKIP_EXACT.has(nm) ||
  (SKIP_PREFIX.some((p) => nm.startsWith(p)) && !KEEP.some((p) => nm.startsWith(p)));
const byShort = new Map();
for (const nm in NODE_COLORS.c) { const s = nm.split(':')[1]; if (!byShort.has(s)) byShort.set(s, nm); }
const PAL = {};
for (const k in NODE_COLORS.pal) {
  const h = NODE_COLORS.pal[k], a = new Uint8Array(768);
  for (let i = 0; i < 768; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  PAL[k] = a;
}
// Best known relative of a node with no color of its own (a stair, slab,
// wall, rotated or numbered variant ...): strip the variant parts.
function relative(nm) {
  if (NODE_COLORS.c[nm]) return nm;
  const [mod, short0] = nm.split(':');
  let s = (short0 || '').replace(/_preserved$/, '');
  const tries = [s];
  for (let i = 0; i < 6; i++) {
    const s2 = s.replace(/(_top|_bottom|_outer|_inner|_open|_on|_off|_lit|_\d+|_cap_\d+|_tall_pillar|_short_pillar|_short_flat|_tall_flat|_flat|_floor|_ceiling|_wall|_small|_bark|_[tb]_\d|_double|_linked_[lr]|_active|_powered|_flowing|_source|_hanging|_tip|_frustum|_middle|_base|_left|_right|_tige|tige_linked_[a-z]|_[lrtb])$/, '');
    if (s2 === s) break;
    s = s2; tries.push(s);
  }
  for (const t of tries.slice()) tries.push(t.replace(/^(stair_|slab_|wall_|fence_|fencegate_|trapdoor_|door_|pane_)/, ''));
  // Last: drop words from the end, then from the front
  // (deepslate_with_coal -> deepslate, block_oxidized_cut -> block_oxidized).
  const words = tries[tries.length - 1].split('_');
  for (let k = words.length - 1; k >= 1; k--) tries.push(words.slice(0, k).join('_'));
  for (let k = 1; k < words.length; k++) tries.push(words.slice(k).join('_'));
  for (const t of tries) {
    if (!t) continue;
    if (NODE_COLORS.c[mod + ':' + t]) return mod + ':' + t;
    if (NODE_COLORS.c[mod + ':block_' + t]) return mod + ':block_' + t;
    if (byShort.has(t)) return byShort.get(t);
    if (byShort.has('wood_' + t)) return byShort.get('wood_' + t);
    if (byShort.has(t.replace(/^(small|medium|large|ominous)_/, ''))) return byShort.get(t.replace(/^(small|medium|large|ominous)_/, ''));
  }
  return null;
}
// name -> {skip, r, g, b, pal}
const nodeInfo = new Map();
const unknownNames = new Map();
function infoFor(nm) {
  let e = nodeInfo.get(nm);
  if (e) return e;
  if (skipName(nm)) e = { skip: true };
  else {
    const rel = relative(nm);
    const hex = rel ? NODE_COLORS.c[rel] : null;
    if (!hex) unknownNames.set(nm, 0);
    const c = hex ? parseInt(hex, 16) : 0x8a8a8a;
    e = { skip: false, r: c >> 16, g: (c >> 8) & 255, b: c & 255, pal: rel ? PAL[NODE_COLORS.p[rel]] || null : null,
      natural: NETHER_NATURAL.has(nm) };
  }
  nodeInfo.set(nm, e);
  return e;
}

// ------------------------------------------------------------ surface
// Results are kept per dimension and output tile: RGB of the top node and
// its height.
const DIMS = ['overworld', 'nether', 'end'];
const tiles = { overworld: new Map(), nether: new Map(), end: new Map() };   // 'tx,tz' -> {rgb, y}
const NOY = -32768;
function tileFor(dim, tx, tz) {
  const k = tx + ',' + tz, m = tiles[dim];
  let t = m.get(k);
  if (!t) { t = { tx, tz, rgb: new Uint8Array(TILE * TILE * 3), y: new Int16Array(TILE * TILE).fill(NOY) }; m.set(k, t); }
  return t;
}
// For each 16x16 mapblock column: the lowest top found so far over its 256
// node columns, once all 256 have one.  A mapblock entirely below that
// cannot change anything, so it is not unpacked at all.
const colFloor = { overworld: new Map(), end: new Map() };
const td = new TextDecoder();
let oldFormat = 0, badBlocks = 0, unpacked = 0, skipped = 0;
// Unpack one mapblock: the node kinds it uses (id -> info), the unpacked
// bytes and where its param0 and param2 arrays start.  `copy` keeps the
// bytes (the decoder reuses its buffer for the next block).
function decodeBlock(blob, copy) {
  const ver = blob[0];
  if (ver < 29) { oldFormat++; return null; }
  let b;
  try { b = zstdDecode(blob.subarray(1)); } catch (e) { badBlocks++; return null; }
  unpacked++;
  let p = 1 + 2 + 4 + 1;          // flags, lighting_complete, timestamp, mapping version
  const n = u16(b, p); p += 2;
  const ids = new Map();
  let any = false;
  for (let i = 0; i < n; i++) {
    const id = u16(b, p), l = u16(b, p + 2);
    const e = infoFor(td.decode(b.subarray(p + 4, p + 4 + l)));
    if (!e.skip) any = true;
    ids.set(id, e);
    p += 4 + l;
  }
  if (b[p] !== 2 || b[p + 1] !== 2) { badBlocks++; return null; }
  p += 2;
  const p0 = p, p2 = p + 8192 + 4096;
  if (b.length < p2 + 4096) { badBlocks++; return null; }
  return { ids, any, b: copy ? b.slice(0, p2 + 4096) : b, p0, p2 };
}
// Node i of an unpacked block: its info, or null if it is open (air, a
// small plant ...).
function nodeAt(d, i) {
  const e = d.ids.get((d.b[d.p0 + 2 * i] << 8) | d.b[d.p0 + 2 * i + 1]);
  return !e || e.skip ? null : e;
}
// Its color, as [r, g, b].
function colorOf(d, i, e) {
  if (!e.pal) return [e.r, e.g, e.b];
  const q = d.b[d.p2 + i] * 3;
  return [(e.r * e.pal[q]) / 255, (e.g * e.pal[q + 1]) / 255, (e.b * e.pal[q + 2]) / 255];
}
// Nether mapblocks are kept (still packed) until the whole file is read,
// then each 16 x 16 column of them is worked out top to bottom.
const netherCols = new Map();     // 'bx,bz' -> {bx, bz, blocks: [[by, blob], ...]}
function applyBlock(dim, bx, by, bz, blob) {
  if (dim === 'nether') {
    const k = bx + ',' + bz;
    let c = netherCols.get(k);
    if (!c) { c = { bx, bz, blocks: [] }; netherCols.set(k, c); }
    c.blocks.push([by, blob.slice()]);
    return;
  }
  const key = bx * 8192 + bz;
  const floor = colFloor[dim].get(key);
  if (floor !== undefined && by * 16 + 15 <= floor) { skipped++; return; }
  const d = decodeBlock(blob, false);
  if (!d || !d.any) return;       // damaged, too old, or only air and the like
  const { ids, b, p0, p2 } = d;
  const x0 = bx * 16, z0 = bz * 16, y0 = by * 16;
  const tx = Math.floor(x0 / TILE), tz = Math.floor(z0 / TILE);
  const t = tileFor(dim, tx, tz);
  const lx0 = x0 - tx * TILE, lz0 = z0 - tz * TILE;
  let low = 32767;
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const o = (lz0 + lz) * TILE + (lx0 + lx);
      const cur = t.y[o];
      for (let ly = 15; ly >= 0 && y0 + ly > cur; ly--) {
        const i = lz * 256 + ly * 16 + lx;           // node index z*256 + y*16 + x
        const e = ids.get((b[p0 + 2 * i] << 8) | b[p0 + 2 * i + 1]);
        if (!e || e.skip) continue;
        let r = e.r, g = e.g, bl = e.b;
        if (e.pal) {
          const q = b[p2 + i] * 3;
          r = (r * e.pal[q]) / 255; g = (g * e.pal[q + 1]) / 255; bl = (bl * e.pal[q + 2]) / 255;
        }
        t.rgb[o * 3] = r; t.rgb[o * 3 + 1] = g; t.rgb[o * 3 + 2] = bl;
        t.y[o] = y0 + ly;
        break;
      }
      if (t.y[o] < low) low = t.y[o];
    }
  }
  if (low > NOY) colFloor[dim].set(key, low);
}
// The Nether: in each node column, from the roof down, the highest built
// block, else the first ground with NETHER_GAP open nodes above it (a
// mapblock that was never saved counts as open).
function netherFloors() {
  for (const c of netherCols.values()) {
    const byY = new Map();
    for (const [by, blob] of c.blocks) {
      const d = decodeBlock(blob, true);
      if (d) byY.set(by, d);
    }
    if (!byY.size) continue;
    const x0 = c.bx * 16, z0 = c.bz * 16;
    const tx = Math.floor(x0 / TILE), tz = Math.floor(z0 / TILE);
    const t = tileFor('nether', tx, tz);
    const lx0 = x0 - tx * TILE, lz0 = z0 - tz * TILE;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        let run = 0, ground = null;
        for (let y = NETHER_MAX; y >= NETHER_MIN; y--) {
          const by = by0(y), d = byY.get(by), i = lz * 256 + (y - by * 16) * 16 + lx;
          const e = d ? nodeAt(d, i) : null;
          if (!e) { run++; continue; }
          if (!e.natural) { ground = [y, colorOf(d, i, e)]; break; }        // built: always shown
          if (!ground && run >= NETHER_GAP) ground = [y, colorOf(d, i, e)];
          run = 0;
        }
        if (ground) {
          const o = (lz0 + lz) * TILE + (lx0 + lx), col = ground[1];
          t.rgb[o * 3] = col[0]; t.rgb[o * 3 + 1] = col[1]; t.rgb[o * 3 + 2] = col[2];
          t.y[o] = ground[0];
        }
      }
    }
  }
  netherCols.clear();
}

// ------------------------------------------------------------ main
function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function run() {
  const t0 = performance.now();
  reader = new FileReaderSync();
  const head = readBytes(0, 100);
  if (td.decode(head.subarray(0, 15)) !== 'SQLite format 3') throw new Error('not-sqlite');
  pageSize = u16(head, 16); if (pageSize === 1) pageSize = 65536;
  usable = pageSize - head[20];
  nPages = Math.floor(file.size / pageSize);
  // Find the blocks table in the schema (page 1).
  let root = 0, sql = '';
  eachCell(leafPages(1), (b, o) => {
    const v = record(cellPayload(b, o));
    if (v[0] === 'table' && v[1] === 'blocks') { root = v[3]; sql = v[4]; }
  });
  if (!root) throw new Error('no-blocks');
  const xyz = /`?x`?\s+INTEGER/i.test(sql);   // 5.12+ layout
  // Read 1: the interior pages, to learn which pages hold the table's rows.
  // (Pages no longer in use can still look like table pages, so only those
  // reachable from the table's root count.)
  const children = new Map();
  scanPages((b, n) => { const h = hdrOff(n); if (b[h] === 5) children.set(n, interiorKids(b, h)); },
    (f) => post({ type: 'progress', phase: 'Opening', frac: f }));
  const isLeaf = new Uint8Array(nPages + 1);
  for (const n of leafPages(root, children)) isLeaf[n] = 1;
  children.clear();
  // Read 2: every row.  Overworld mapblocks are unpacked and their top
  // nodes kept; a mapblock below what is already known is passed over.
  let total = 0;
  const counts = { overworld: 0, nether: 0, end: 0 };
  const s12 = (k) => (k >= 2048 ? k - 4096 : k);
  scanPages((b, n) => {
    if (!isLeaf[n]) return;
    const h = hdrOff(n), cells = u16(b, h + 3);
    for (let c = 0; c < cells; c++) {
      const o = u16(b, h + 8 + 2 * c);
      total++;
      const [P, l1] = varint(b, o);
      const [, l2] = varint(b, o + l1);
      const start = o + l1 + l2;
      const v = record(b.subarray(start, start + localSize(P)));   // key columns are always on the page
      let x, y, z, blob;
      if (xyz) { x = v[0]; y = v[1]; z = v[2]; blob = v[3]; }
      else {
        // pos = z*0x1000000 + y*0x1000 + x, each part a signed 12-bit number.
        let pos = v[0];
        x = s12(((pos % 4096) + 4096) % 4096); pos = (pos - x) / 4096;
        y = s12(((pos % 4096) + 4096) % 4096); pos = (pos - y) / 4096;
        z = pos; blob = v[1];
      }
      const dim = dimOf(y);
      if (!dim || !blob || !blob.blob) continue;
      counts[dim]++;
      const pay = localSize(P) === P ? b.subarray(start, start + P) : cellPayload(b, o);
      applyBlock(dim, x, y, z, pay.subarray(blob.blob[0], blob.blob[1]));
    }
  }, (f) => post({ type: 'progress', phase: 'Reading your world', frac: f }));
  // Shade slopes (lighter facing north-west, like a lit relief map) and
  // send each tile to the page.
  post({ type: 'progress', phase: 'Drawing', frac: 1 });
  netherFloors();
  for (const dim of DIMS) {
    const m = tiles[dim];
    const heightAt = (x, z) => {
      const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE), t = m.get(tx + ',' + tz);
      return t ? t.y[(z - tz * TILE) * TILE + (x - tx * TILE)] : NOY;
    };
    const list = Array.from(m.values());
    for (const t of list) {
      const rgba = new Uint8ClampedArray(TILE * TILE * 4);
      const X0 = t.tx * TILE, Z0 = t.tz * TILE;
      for (let lz = 0; lz < TILE; lz++) {
        for (let lx = 0; lx < TILE; lx++) {
          const o = lz * TILE + lx, y = t.y[o];
          if (y === NOY) continue;
          // Image rows run north (high Z) to south.
          const d = ((TILE - 1 - lz) * TILE + lx) * 4;
          const yn = lx > 0 && lz < TILE - 1 ? t.y[o + TILE - 1] : heightAt(X0 + lx - 1, Z0 + lz + 1);
          const k = yn === NOY ? 1 : 1 + Math.max(-4, Math.min(4, y - yn)) * 0.06;
          rgba[d] = t.rgb[o * 3] * k; rgba[d + 1] = t.rgb[o * 3 + 1] * k; rgba[d + 2] = t.rgb[o * 3 + 2] * k; rgba[d + 3] = 255;
        }
      }
      t.rgba = rgba;
    }
    for (const t of list) post({ type: 'tile', dim, tx: t.tx, tz: t.tz, size: TILE, rgba: t.rgba.buffer, heights: t.y.buffer }, [t.rgba.buffer, t.y.buffer]);
    m.clear();
  }
  post({
    type: 'done', blocks: total, counts, unpacked, skipped,
    oldFormat, badBlocks, unknown: Array.from(unknownNames.keys()).slice(0, 50), unknownCount: unknownNames.size,
    ms: Math.round(performance.now() - t0),
  });
}

self.onmessage = (e) => {
  file = e.data.file;
  try {
    zstdInit();
    run();
  } catch (err) {
    post({ type: 'error', code: String(err && err.message || err) });
  }
};
