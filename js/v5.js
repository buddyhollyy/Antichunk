// The v5 map generator, ported from Luanti (LGPL-2.1-or-later) and
// Mineclonia (GPL-3.0):
//   src/mapgen/mapgen_v5.cpp   MapgenV5::generateBaseTerrain and
//                              getSpawnLevelAtPoint (Luanti)
//   mods/MAPGEN/mcl_mapgen_models/v5.lua   Mineclonia's model of v5, which
//                              it uses to place structures
//
// The whole ground is one 3D noise ("ground") around a 2D height, scaled
// by a 2D "factor" noise: flat where the factor is low, wild with
// overhangs and floating bits where it is high.  v5 has no options that
// change the surface (its one option, caverns, is underground).  Default
// settings are assumed (water_level 1, chunksize 5).
(function (root) {
  'use strict';
  const N = (typeof module !== 'undefined' && module.exports) ? require('./noise.js') : root.LuantiNoise;
  const fr = Math.fround;

  const CHUNK = 80, CHUNK_OFFSET = -32;
  const WATER_LEVEL = 1;
  const NP = {
    factor: N.NP(0, 1,  [250, 250, 250], 920381, 3, 0.45, 2.0),
    height: N.NP(0, 10, [250, 250, 250], 84174,  4, 0.5,  2.0),
    ground: N.NP(0, 40, [80, 80, 80],    983240, 4, 0.55, 2.0, N.FLAG_EASED),
  };
  const G = NP.ground;

  function chunkOrigin(v) {
    return Math.floor((v - CHUNK_OFFSET) / CHUNK) * CHUNK + CHUNK_OFFSET;
  }

  // float f = 0.55 + factor; (0.55 and 1.6 are doubles in C++)
  function factorOf(n) {
    let f = fr(0.55 + n);
    if (f < 0.01) f = fr(0.01);
    else if (f >= 1.0) f = fr(f * 1.6);
    return f;
  }

  // Octave weights of the ground noise (before its scale of 40): what is
  // left after octave o, and how fast the whole noise can change per node
  // in y (eased interpolation is at most 1.5 times steeper than linear).
  const G_REST = [], G_DY = (() => {
    const gs = []; let g = 1, f = 1, dy = 0;
    for (let o = 0; o < G.octaves; o++) { gs.push(g); dy += g * 1.5 * 2 * f / G.spread[1]; g *= G.persist; f *= G.lacunarity; }
    for (let o = 0; o < gs.length; o++) G_REST.push(gs.slice(o + 1).reduce((a, b) => a + b, 0) * 1.0001);
    return dy * 1.0001 * Math.abs(G.scale);
  })();
  const G_MAX = (G_REST[0] + 1.0001) * Math.abs(G.scale);

  function GroundCache(seed, cx, cz) { this.seed = seed; this.cx = cx; this.cz = cz; this.maps = new Map(); }
  GroundCache.prototype.get = function (cy) {
    let m = this.maps.get(cy);
    if (!m) {
      m = new N.NoiseMap3D(G, this.seed, this.cx, cy - 1, this.cz, CHUNK, CHUNK + 2, CHUNK);
      this.maps.set(cy, m);
    }
    return m;
  };

  // Top solid y of one column: solid where !(ground * f < y - h).
  function topSolid(maps, i, k, f, h) {
    const reach = G_MAX * f;
    const yHi = Math.floor(h + reach) + 1, yLo = Math.ceil(h - reach) - 1;
    const eps = 1e-3 * (1 + reach);
    const rate = G_DY * f + 1; // most (ground * f - (y - h)) can grow per node down
    const cols = new Map();
    for (let y = yHi; y > yLo; y--) {
      const cy = chunkOrigin(y), j = y - (cy - 1);
      const m = maps.get(cy);
      let cc = cols.get(cy);
      if (!cc) { cc = []; cols.set(cy, cc); }
      const delta = y - h;
      let r = 0, decided = 0;
      for (let o = 0; o < G.octaves - 1; o++) {
        r += m.oct[o].g * m.octaveValueCol(o, i, j, k, cc);
        const best = G.scale * (r + G_REST[o]) * f - delta;
        if (best < -eps) {
          const d = Math.floor((-best - eps) / rate);
          if (d > 1) y -= d - 1;
          decided = -1; break;
        }
        if (G.scale * (r - G_REST[o]) * f - delta > eps) { decided = 1; break; }
      }
      if (decided === 1) return y;
      if (decided === -1) continue;
      const g = m.getCol(i, j, k, cc);
      if (!(fr(g * f) < fr(y - h))) return y;
    }
    return yLo;
  }

  // Same output as LuantiV7.generateChunkTop.
  function generateChunkTop(seed, cx, cz, step) {
    step = step || 1;
    const S = CHUNK, m = Math.ceil(S / step), n = m * m;
    const nf = N.noiseMap2D(NP.factor, seed, cx, cz, S, S, null, step);
    const nh = N.noiseMap2D(NP.height, seed, cx, cz, S, S, null, step);
    const maps = new GroundCache(seed, cx, cz);
    const surface = new Int16Array(n), water = new Uint8Array(n);
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const idx = kk * m + ii;
      const top = topSolid(maps, ii * step, kk * step, factorOf(nf[idx]), nh[idx]);
      surface[idx] = top;
      water[idx] = top < WATER_LEVEL ? 1 : 0;
    }
    return { size: m, step, surface, water, base: surface };
  }

  // getSpawnLevelAtPoint: spawn y, or null when unsuitable.
  function spawnLevel(seed, x, z) {
    const f = factorOf(N.noiseFractal2D(NP.factor, x, z, seed));
    const h = N.noiseFractal2D(NP.height, x, z, seed);
    const maxSpawnY = Math.max(Math.trunc(NP.height.offset), WATER_LEVEL + 16); // 17
    // Quick answers: nothing above h + G_MAX * f can be solid, everything
    // below h - G_MAX * f is.
    if (h - G_MAX * f - 2 > maxSpawnY) return null;
    if (h + G_MAX * f + 2 < WATER_LEVEL) return null;
    const start = Math.min(maxSpawnY + 128, Math.floor(h + G_MAX * f) + 2);
    for (let y = start; y >= WATER_LEVEL; y--) {
      const g = N.noiseFractal3D(G, x, y, z, seed);
      if (fr(g * f) > fr(y - h)) {
        if (y < WATER_LEVEL || y > maxSpawnY) return null;
        return y + 2;
      }
    }
    return null;
  }

  // Mineclonia's model (v5.lua).  Lua numbers are doubles, so the
  // arithmetic here is in double precision on the single-point noise.
  const MAX_GROUND_LUA = (() => { let a = 1.0, g = 1.0; for (let i = 0; i < G.octaves; i++) { a += g; g *= G.persist; } return G.offset + a * G.scale; })();
  const GROUND_SAMPLES = [-8, -4, 0, 4, 8, 16, 24, 32, 64, 72, 84];
  function Model(seed32) { this.seed = seed32; }
  Model.prototype.fh = function (x, z) {
    let f = Math.max(0.01, 0.55 + N.noiseFractal2D(NP.factor, x, z, this.seed));
    if (f >= 1.0) f = f * 1.6;
    return [f, N.noiseFractal2D(NP.height, x, z, this.seed)];
  };
  // get_biome_override: 'DeepOcean', 'Ocean' or null.  (x, z) in Luanti coordinates.
  Model.prototype.biomeOverride = function (x, z) {
    const [f, height] = this.fh(x, z);
    let avg = 0.0;
    for (const y of GROUND_SAMPLES) avg += N.noiseFractal3D(G, x, y, z, this.seed);
    avg /= GROUND_SAMPLES.length;
    const h = f * avg + height;
    if (h < -25) return 'DeepOcean';
    if (h < -2) return 'Ocean';
    return null;
  };
  // get_column_height: first y above the ground as Mineclonia's model sees it.
  Model.prototype.columnHeight = function (x, z, liquidsSolid) {
    const [f, height] = this.fh(x, z);
    const maxY = Math.ceil(Math.ceil(MAX_GROUND_LUA * f) + height);
    if (liquidsSolid && maxY <= WATER_LEVEL) return WATER_LEVEL + 1;
    const minY = Math.floor(Math.floor(-MAX_GROUND_LUA * f) + height);
    for (let y = maxY; y >= minY; y--) {
      if (N.noiseFractal3D(G, x, y, z, this.seed) * f >= y - height) return y + 1;
      if (liquidsSolid && y <= WATER_LEVEL) return y + 1;
    }
    return minY;
  };

  const api = { NP, WATER_LEVEL, factorOf, generateChunkTop, spawnLevel, Model };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LuantiV5 = api;
})(typeof self !== 'undefined' ? self : this);
