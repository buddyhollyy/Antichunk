// Port of Luanti's v7 terrain shape (src/mapgen/mapgen_v7.cpp,
// MapgenV7::generateTerrain) with default settings:
// mgv7_spflags = mountains, ridges, nofloatlands, caverns; water_level = 1;
// chunksize = 5 (80 nodes). Luanti is LGPL-2.1-or-later.
//
// For a top-down map we only need, per column, the highest solid node and
// whether water sits on top of it. Caves and biomes are not handled here.
(function (root) {
  'use strict';
  const N = (typeof module !== 'undefined' && module.exports) ? require('./noise.js') : root.LuantiNoise;
  const fr = Math.fround;

  const CHUNK = 80;          // chunksize 5 * MAP_BLOCKSIZE 16
  const CHUNK_OFFSET = -32;  // chunks are centered: -chunksize/2 blocks
  const WATER_LEVEL = 1;
  const MOUNT_ZERO_LEVEL = 0;

  const NP = {
    terrain_base:    N.NP(4.0,   70.0,  [600, 600, 600],   82341, 5, 0.6,  2.0),
    terrain_alt:     N.NP(4.0,   25.0,  [600, 600, 600],   5934,  5, 0.6,  2.0),
    terrain_persist: N.NP(0.6,   0.1,   [2000, 2000, 2000], 539,  3, 0.6,  2.0),
    height_select:   N.NP(-8.0,  16.0,  [500, 500, 500],   4213,  6, 0.7,  2.0),
    mount_height:    N.NP(256.0, 112.0, [1000, 1000, 1000], 72449, 3, 0.6, 2.0),
    ridge_uwater:    N.NP(0.0,   1.0,   [1000, 1000, 1000], 85039, 5, 0.6, 2.0),
    mountain:        N.NP(-0.6,  1.0,   [250, 350, 250],   5333,  5, 0.63, 2.0),
    ridge:           N.NP(0.0,   1.0,   [100, 100, 100],   6467,  4, 0.75, 2.0),
  };

  function chunkOrigin(v) {
    return Math.floor((v - CHUNK_OFFSET) / CHUNK) * CHUNK + CHUNK_OFFSET;
  }

  // Largest possible value of a fractal noise sum (each octave is in [-1, 1]).
  function ampSum(np) {
    let a = 0, g = 1;
    for (let o = 0; o < np.octaves; o++) { a += g; g *= np.persist; }
    return a;
  }
  const MOUNTAIN_MAX = NP.mountain.offset + NP.mountain.scale * ampSum(NP.mountain);
  const RIDGE_MAX = ampSum(NP.ridge);
  const WIDTH = fr(0.2), SIX = fr(0.6);
  // MOUNT_REST[o]: largest possible sum of the octaves after octave o.
  const MOUNT_REST = [];
  { let g = 1; const gs = [];
    for (let o = 0; o < NP.mountain.octaves; o++) { gs.push(g); g *= NP.mountain.persist; }
    for (let o = 0; o < gs.length; o++) MOUNT_REST.push(gs.slice(o + 1).reduce((a, b) => a + b, 0) * 1.0001); }

  // 3D noise maps are cached per mapchunk (x, y, z origin).
  function ChunkColumn(seed, cx, cz) {
    this.seed = seed; this.cx = cx; this.cz = cz;
    this.mountain = new Map();
    this.ridge = new Map();
  }
  ChunkColumn.prototype.map3d = function (cache, np, cy) {
    let m = cache.get(cy);
    if (!m) {
      m = new N.NoiseMap3D(np, this.seed, this.cx, cy - 1, this.cz, CHUNK, CHUNK + 2, CHUNK);
      cache.set(cy, m);
    }
    return m;
  };

  // Generate the top-down data for the mapchunk column whose corner is (cx, cz).
  // Returns { size, surface: Int16Array (top solid y), water: Uint8Array (1 if
  // water above it), base: Int16Array (base terrain level, before mountains
  // and rivers) }, index = row * size + col, row along +Z, col along +X.
  // With step > 1 only every step-th column in each direction is computed.
  function generateChunkTop(seed, cx, cz, step) {
    step = step || 1;
    const S = CHUNK, m = Math.ceil(S / step), n = m * m;
    const persist = N.noiseMap2D(NP.terrain_persist, seed, cx, cz, S, S, null, step);
    const tbase = N.noiseMap2D(NP.terrain_base, seed, cx, cz, S, S, persist, step);
    const talt = N.noiseMap2D(NP.terrain_alt, seed, cx, cz, S, S, persist, step);
    const hsel = N.noiseMap2D(NP.height_select, seed, cx, cz, S, S, null, step);
    const mheight = N.noiseMap2D(NP.mount_height, seed, cx, cz, S, S, null, step);
    const uwater = N.noiseMap2D(NP.ridge_uwater, seed, cx, cz, S, S, null, step);

    const col = new ChunkColumn(seed, cx, cz);
    const surface = new Int16Array(n), water = new Uint8Array(n), base = new Int16Array(n);

    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const idx = kk * m + ii, i = ii * step, k = kk * step;
      // baseTerrainLevelFromMap
      let hs = hsel[idx]; hs = hs < 0 ? 0 : hs > 1 ? 1 : hs;
      const hb = tbase[idx], ha = talt[idx];
      const level = ha > hb ? ha : fr(fr(hb * hs) + fr(ha * fr(1 - hs)));
      const surfaceY = Math.trunc(level); // (s16) cast
      base[idx] = surfaceY;

      const c = {
        i, k, surfaceY,
        mnth: Math.max(mheight[idx], 1),
        absuw: fr(Math.abs(uwater[idx]) * 2),
        mc: [], rc: [], // per-column lattice caches for mountain / ridge noise
      };
      c.nearRiver = c.absuw <= WIDTH; // (absuwatern > width) => no channel

      // Highest y where mountain terrain could exist: mountn - y/mnth >= 0.
      const yMountMax = Math.ceil(MOUNTAIN_MAX * c.mnth) + MOUNT_ZERO_LEVEL + 1;
      // Scan down to the first solid node. River channels can only reach
      // down to about y = -9 (they need (altitude + 17) / 2.5 * width_mod
      // >= 0.6), so the scan always ends by min(surfaceY, -10).
      const yLow = Math.min(surfaceY, -10);
      let top = yLow;
      for (let y = Math.max(yMountMax, surfaceY); y > yLow; y--) {
        if (y > surfaceY) {
          const d = mountainSkip(col, c, y);
          if (d > 0) { y = Math.max(y - d, surfaceY) + 1; continue; }
        }
        if (isSolid(col, c, y)) { top = y; break; }
      }
      surface[idx] = top;
      water[idx] = top < WATER_LEVEL ? 1 : 0;
    }
    return { size: m, step, surface, water, base };
  }

  // Above the base terrain only mountains can be solid. Each octave o of the
  // mountain noise is a linear interpolation between lattice values in
  // [-1, 1] spaced 350 / 2^o nodes apart in y, so it changes by at most
  // 2 * 2^o / 350 per node. The height gradient changes by 1 / mnth per node.
  // If even the best case is clearly below the solid threshold, no node in
  // the next d nodes down can be solid, so the scan can jump past them.
  const MOUNT_SLOPE = [];
  { let s = 0, g = 1, f = 1;
    for (let o = 0; o < NP.mountain.octaves; o++) {
      s += g * 2 * f / NP.mountain.spread[1];
      MOUNT_SLOPE.push(s * NP.mountain.scale);
      g *= NP.mountain.persist; f *= NP.mountain.lacunarity;
    } }
  function mountainSkip(col, c, y) {
    const cy = chunkOrigin(y);
    const j = y - (cy - 1);
    const m = col.map3d(col.mountain, NP.mountain, cy);
    const np = NP.mountain;
    const grad = -(y - MOUNT_ZERO_LEVEL) / c.mnth;
    let r = 0, skip = 0;
    for (let o = 0; o < np.octaves; o++) {
      r += m.oct[o].g * m.octaveValueCol(o, c.i, j, c.k, c.mc);
      const best = np.offset + np.scale * (r + MOUNT_REST[o]) + grad;
      if (best > -0.01) continue;
      const d = Math.floor((-best - 0.005) / (MOUNT_SLOPE[o] + 1 / c.mnth)) - 1;
      if (d > skip) skip = d;
    }
    return skip;
  }

  function isSolid(col, c, y) {
    const cy = chunkOrigin(y);
    const j = y - (cy - 1);
    // River channel (ridges). gen_rivers requires node_max.Y >= water_level - 16.
    let river = false;
    if (c.nearRiver && cy + CHUNK - 1 >= WATER_LEVEL - 16) {
      const altitude = fr(y - WATER_LEVEL);
      const heightMod = fr(fr(altitude + 17) / 2.5);
      const widthMod = fr(WIDTH - c.absuw);
      const wh = fr(widthMod * heightMod);
      const altPos = Math.max(altitude, 0);
      // Cheap bound before evaluating the 3D ridge noise.
      if ((RIDGE_MAX * altPos) / 7 + wh >= 0.6 - 1e-4) {
        const ridge = col.map3d(col.ridge, NP.ridge, cy).getCol(c.i, j, c.k, c.rc);
        const nridge = fr(fr(ridge * altPos) / 7);
        river = fr(nridge + wh) >= SIX;
      }
    }
    if (y <= c.surfaceY) return !river;
    if (river) return false;
    // Mountain terrain: mountn + density_gradient >= 0
    const grad = fr(-fr(fr(y - MOUNT_ZERO_LEVEL) / c.mnth));
    if (MOUNTAIN_MAX + grad < -1e-4) return false;
    const m = col.map3d(col.mountain, NP.mountain, cy);
    // Add octaves one at a time and stop as soon as the answer is certain.
    // The margin (1e-3) is far larger than float rounding error; when the
    // value is that close to the threshold the exact float result decides.
    const np = NP.mountain;
    let r = 0;
    for (let o = 0; o < np.octaves; o++) {
      r += m.oct[o].g * m.octaveValueCol(o, c.i, j, c.k, c.mc);
      const rem = MOUNT_REST[o];
      if (np.offset + np.scale * (r + rem) + grad < -1e-3) return false;
      if (np.offset + np.scale * (r - rem) + grad > 1e-3) return true;
    }
    return fr(m.getCol(c.i, j, c.k, c.mc) + grad) >= 0;
  }

  const api = { CHUNK, CHUNK_OFFSET, WATER_LEVEL, NP, chunkOrigin, generateChunkTop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LuantiV7 = api;
})(typeof self !== 'undefined' ? self : this);
