// The Carpathian map generator, ported from Luanti (LGPL-2.1-or-later)
// and Mineclonia (GPL-3.0):
//   src/mapgen/mapgen_carpathian.cpp  MapgenCarpathian::generateTerrain and
//                                     getSpawnLevelAtPoint (Luanti)
//   src/mapgen/mapgen_carpathian.h    default settings (Luanti)
//   mods/MAPGEN/mcl_mapgen_models/carpathian.lua   Mineclonia's model of
//                                     Carpathian, used to place structures
//
// Rolling hills, ridged mountains and terraced ("step") mountains on a
// base level of 12, mixed by 2D noises and a 3D noise ("mnt_var") that
// makes cliffs and overhangs.  The "Rivers" option (setting
// mgcarpathian_spflags, off by default) adds sea-level rivers in valleys.
// Other settings are assumed to be the defaults (base_level 12,
// river_width 0.05, river_depth 24, valley_width 0.25, water_level 1).
(function (root) {
  'use strict';
  const N = (typeof module !== 'undefined' && module.exports) ? require('./noise.js') : root.LuantiNoise;
  const fr = Math.fround;

  const CHUNK = 80, CHUNK_OFFSET = -32;
  const WATER_LEVEL = 1;
  const BASE_LEVEL = fr(12), RIVER_WIDTH = fr(0.05), RIVER_DEPTH = fr(24), VALLEY_WIDTH = fr(0.25);
  const GRAD_WL = 1 - WATER_LEVEL;

  const NP = {
    height1:       N.NP(0, 5,  [251, 251, 251],    9613,  5, 0.5,  2.0),
    height2:       N.NP(0, 5,  [383, 383, 383],    1949,  5, 0.5,  2.0),
    height3:       N.NP(0, 5,  [509, 509, 509],    3211,  5, 0.5,  2.0),
    height4:       N.NP(0, 5,  [631, 631, 631],    1583,  5, 0.5,  2.0),
    hills_terrain: N.NP(1, 1,  [1301, 1301, 1301], 1692,  5, 0.5,  2.0),
    ridge_terrain: N.NP(1, 1,  [1889, 1889, 1889], 3568,  5, 0.5,  2.0),
    step_terrain:  N.NP(1, 1,  [1889, 1889, 1889], 4157,  5, 0.5,  2.0),
    hills:         N.NP(0, 3,  [257, 257, 257],    6604,  6, 0.5,  2.0),
    ridge_mnt:     N.NP(0, 12, [743, 743, 743],    5520,  6, 0.7,  2.0),
    step_mnt:      N.NP(0, 8,  [509, 509, 509],    2590,  6, 0.6,  2.0),
    rivers:        N.NP(0, 1,  [1000, 1000, 1000], 85039, 5, 0.6,  2.0),
    mnt_var:       N.NP(0, 1,  [499, 499, 499],    2490,  5, 0.55, 2.0),
  };
  const MV = NP.mnt_var;

  // "carpathian" or "carpathian:rivers" -> flags.
  function parseFlags(spec) {
    const list = String(spec || '').split(':')[1] || '';
    return { rivers: list.split(',').map((s) => s.trim()).includes('rivers') };
  }

  function chunkOrigin(v) {
    return Math.floor((v - CHUNK_OFFSET) / CHUNK) * CHUNK + CHUNK_OFFSET;
  }

  // MapgenCarpathian::getSteps and getLerp (single-precision floats).
  function getSteps(noise) {
    const w = fr(0.5);
    const k = Math.floor(fr(noise / w));
    const f = fr(fr(noise - fr(k * w)) / w);
    const s = Math.min(fr(2 * f), 1);
    return fr(fr(k + s) * w);
  }
  function getLerp(a, b, mod) { return fr(a + fr(mod * fr(b - a))); }

  // The per-column part of generateTerrain before the vertical loop.
  function columnShape(h1, h2, h3, h4, nHillsTerrain, nHills, nRidgeTerrain, nRidgeMnt, nStepTerrain, nStepMnt, nRivers, flags) {
    const hterabs = Math.abs(nHillsTerrain);
    const hill_mnt = fr(fr(fr(fr(hterabs * hterabs) * hterabs) * nHills) * nHills);
    const rterabs = Math.abs(nRidgeTerrain);
    const ridge_mnt = fr(fr(fr(rterabs * rterabs) * rterabs) * fr(1 - Math.abs(nRidgeMnt)));
    const sterabs = Math.abs(nStepTerrain);
    const step_mnt = fr(fr(fr(sterabs * sterabs) * sterabs) * getSteps(nStepMnt));
    let valley = 1, river = 0;
    if (flags.rivers) {
      river = fr(Math.abs(nRivers) - RIVER_WIDTH);
      if (river <= VALLEY_WIDTH) {
        if (river < 0) valley = river;
        else {
          const riversc = fr(river / VALLEY_WIDTH);
          valley = fr(fr(riversc * riversc) * fr(3 - fr(2 * riversc)));
        }
      }
    }
    return { h1, h2, h3, h4, hill_mnt, ridge_mnt, step_mnt, valley, river };
  }

  // Surface level at height y for mnt_var value m (as in the C++ loop).
  // riversOn: rivers are on and this mapchunk has node_max.Y >= water_level - 16.
  function surfaceLevel(c, y, m, riversOn) {
    const hill1 = getLerp(c.h1, c.h2, m), hill2 = getLerp(c.h3, c.h4, m);
    const hill3 = getLerp(c.h3, c.h2, m), hill4 = getLerp(c.h1, c.h4, m);
    const hilliness = Math.max(Math.min(hill1, hill2), Math.min(hill3, hill4));
    const hills = fr(c.hill_mnt * hilliness);
    const ridged = fr(c.ridge_mnt * hilliness);
    const step = fr(c.step_mnt * hilliness);
    const grad = y < WATER_LEVEL ? GRAD_WL + (WATER_LEVEL - y) * 3 : 1 - y;
    const mountains = fr(fr(hills + ridged) + step);
    let s = fr(fr(BASE_LEVEL + mountains) + grad);
    if (riversOn && c.river <= VALLEY_WIDTH) {
      if (c.valley < 0) s = Math.min(s, fr(WATER_LEVEL - fr(fr(Math.sqrt(fr(-c.valley))) * RIVER_DEPTH)));
      else if (s > WATER_LEVEL) s = fr(WATER_LEVEL + fr(fr(s - WATER_LEVEL) * c.valley));
    }
    return s;
  }

  // Bounds on the surface level when mnt_var lies in [lo, hi] (doubles,
  // with a small margin added by the caller).
  function surfaceBounds(c, y, lo, hi, riversOn) {
    const iv = (a, b) => { const p = a + lo * (b - a), q = a + hi * (b - a); return [Math.min(p, q), Math.max(p, q)]; };
    const A = iv(c.h1, c.h2), B = iv(c.h3, c.h4), C = iv(c.h3, c.h2), D = iv(c.h1, c.h4);
    const hLo = Math.max(Math.min(A[0], B[0]), Math.min(C[0], D[0]));
    const hHi = Math.max(Math.min(A[1], B[1]), Math.min(C[1], D[1]));
    const K = c.hill_mnt + c.ridge_mnt + c.step_mnt;
    const mLo = Math.min(K * hLo, K * hHi), mHi = Math.max(K * hLo, K * hHi);
    const grad = y < WATER_LEVEL ? GRAD_WL + (WATER_LEVEL - y) * 3 : 1 - y;
    let sLo = BASE_LEVEL + mLo + grad, sHi = BASE_LEVEL + mHi + grad;
    if (riversOn && c.river <= VALLEY_WIDTH) {
      if (c.valley < 0) {
        const bed = WATER_LEVEL - Math.sqrt(-c.valley) * RIVER_DEPTH;
        sLo = Math.min(sLo, bed); sHi = Math.min(sHi, bed);
      } else {
        const sl = (s) => (s > WATER_LEVEL ? WATER_LEVEL + (s - WATER_LEVEL) * c.valley : s);
        sLo = sl(sLo); sHi = sl(sHi);
      }
    }
    return [sLo, sHi];
  }

  // Octave weights of mnt_var: what is left after octave o, and how fast
  // the whole noise can change per node in y.
  const MV_REST = [], MV_DY = (() => {
    const gs = []; let g = 1, f = 1, dy = 0;
    for (let o = 0; o < MV.octaves; o++) { gs.push(g); dy += g * 2 * f / MV.spread[1]; g *= MV.persist; f *= MV.lacunarity; }
    for (let o = 0; o < gs.length; o++) MV_REST.push(gs.slice(o + 1).reduce((a, b) => a + b, 0) * 1.0001);
    return dy * 1.0001;
  })();
  const MV_MAX = MV_REST[0] + 1.0001;

  function MntCache(seed, cx, cz) { this.seed = seed; this.cx = cx; this.cz = cz; this.maps = new Map(); }
  MntCache.prototype.get = function (cy) {
    let m = this.maps.get(cy);
    if (!m) {
      m = new N.NoiseMap3D(MV, this.seed, this.cx, cy - 1, this.cz, CHUNK, CHUNK + 2, CHUNK);
      this.maps.set(cy, m);
    }
    return m;
  };

  // Top solid y of one column: solid where y < surface level.
  function topSolid(maps, i, k, c, flags) {
    // Highest possible solid y: surface level at most BASE + mountains + grad.
    const [, sTop] = surfaceBounds(c, 1, -MV_MAX, MV_MAX, false);
    const yHi = Math.max(Math.floor((sTop + 1) / 2) + 2, 2);
    const K = Math.abs(c.hill_mnt) + Math.abs(c.ridge_mnt) + Math.abs(c.step_mnt);
    const L = Math.max(Math.abs(c.h2 - c.h1), Math.abs(c.h4 - c.h3), Math.abs(c.h2 - c.h3), Math.abs(c.h4 - c.h1));
    const rate = 4 + K * L * MV_DY;           // most the margin (surface - y) can grow per node down
    const cols = new Map();
    for (let y = yHi; ; y--) {
      const cy = chunkOrigin(y), j = y - (cy - 1);
      const riversOn = flags.rivers && cy + CHUNK - 1 >= WATER_LEVEL - 16;
      const m = maps.get(cy);
      let cc = cols.get(cy);
      if (!cc) { cc = []; cols.set(cy, cc); }
      const eps = 1e-3 * (1 + K * (Math.abs(c.h1) + Math.abs(c.h2) + Math.abs(c.h3) + Math.abs(c.h4)));
      let r = 0, decided = 0;
      for (let o = 0; o < MV.octaves - 1; o++) {
        r += m.oct[o].g * m.octaveValueCol(o, i, j, k, cc);
        const [sLo, sHi] = surfaceBounds(c, y, r - MV_REST[o], r + MV_REST[o], riversOn);
        if (sHi - y < -eps) {
          // (Never past this mapchunk: rivers are only cut in some mapchunks.)
          const d = Math.min(Math.floor((y - sHi - eps) / rate), y - cy);
          if (d > 1) y -= d - 1;
          decided = -1; break;
        }
        if (sLo - y > eps) { decided = 1; break; }
      }
      if (decided === 1) return y;
      if (decided === -1) continue;
      const mv = m.getCol(i, j, k, cc);
      if (y < surfaceLevel(c, y, mv, riversOn)) return y;
    }
  }

  // Same output as LuantiV7.generateChunkTop.
  function generateChunkTop(seed, cx, cz, step, flags) {
    step = step || 1;
    const S = CHUNK, m = Math.ceil(S / step), n = m * m;
    const map = (np) => N.noiseMap2D(np, seed, cx, cz, S, S, null, step);
    const h1 = map(NP.height1), h2 = map(NP.height2), h3 = map(NP.height3), h4 = map(NP.height4);
    const ht = map(NP.hills_terrain), rt = map(NP.ridge_terrain), st = map(NP.step_terrain);
    const hi = map(NP.hills), rm = map(NP.ridge_mnt), sm = map(NP.step_mnt);
    const rv = flags.rivers ? map(NP.rivers) : null;
    const maps = new MntCache(seed, cx, cz);
    const surface = new Int16Array(n), water = new Uint8Array(n);
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const idx = kk * m + ii;
      const c = columnShape(h1[idx], h2[idx], h3[idx], h4[idx], ht[idx], hi[idx], rt[idx], rm[idx], st[idx], sm[idx],
        rv ? rv[idx] : 0, flags);
      const top = topSolid(maps, ii * step, kk * step, c, flags);
      surface[idx] = top;
      water[idx] = top < WATER_LEVEL ? 1 : 0;
    }
    return { size: m, step, surface, water, base: surface };
  }

  // getSpawnLevelAtPoint: spawn y, or null when unsuitable.  The engine
  // applies river valleys here only if the last mapchunk it generated
  // reached y -15; this assumes it did.
  function spawnLevel(seed, x, z, flags) {
    const p = (np) => N.noiseFractal2D(np, x, z, seed);
    let nr = 0;
    if (flags.rivers) {
      nr = p(NP.rivers);
      if (fr(Math.abs(nr) - RIVER_WIDTH) < 0) return null;
    }
    const c = columnShape(p(NP.height1), p(NP.height2), p(NP.height3), p(NP.height4), p(NP.hills_terrain), p(NP.hills),
      p(NP.ridge_terrain), p(NP.ridge_mnt), p(NP.step_terrain), p(NP.step_mnt), nr, flags);
    // Quick answers: if even the highest possible surface is under water,
    // or the lowest possible surface is above y 34, no spot qualifies.
    const [, sHi] = surfaceBounds(c, WATER_LEVEL, -MV_MAX, MV_MAX, flags.rivers);
    if (sHi <= WATER_LEVEL - 1e-3) return null;
    let solidBelow = false, consNonSolid = 0;
    for (let y = WATER_LEVEL; y <= WATER_LEVEL + 32; y++) {
      const mv = N.noiseFractal3D(MV, x, y, z, seed);
      if (y < surfaceLevel(c, y, mv, flags.rivers)) { solidBelow = true; consNonSolid = 0; }
      else {
        consNonSolid++;
        if (consNonSolid === 3 && solidBelow) return y - 1;
      }
    }
    return null;
  }

  // Mineclonia's model (carpathian.lua).  Lua numbers are doubles, so the
  // arithmetic here is in double precision on the single-point noise.
  const MAX_MNT_VAR_LUA = (() => { let a = 1.0, g = 1.0; for (let i = 0; i < MV.octaves; i++) { a += g; g *= MV.persist; } return MV.offset + a * MV.scale; })();
  function Model(seed32, flags) { this.seed = seed32; this.flags = flags; }
  Model.prototype.n2 = function (np, x, z) { return N.noiseFractal2D(np, x, z, this.seed); };
  Model.prototype.base = function (x, z) {
    const steps = (n) => { const w = 0.5, k = Math.floor(n / w), f = (n - k * w) / w; return (k + Math.min(2.0 * f, 1.0)) * w; };
    const hterabs = Math.abs(this.n2(NP.hills_terrain, x, z)), nh = this.n2(NP.hills, x, z);
    const rterabs = Math.abs(this.n2(NP.ridge_terrain, x, z)), nr = this.n2(NP.ridge_mnt, x, z);
    const sterabs = Math.abs(this.n2(NP.step_terrain, x, z)), ns = this.n2(NP.step_mnt, x, z);
    return {
      h1: this.n2(NP.height1, x, z), h2: this.n2(NP.height2, x, z), h3: this.n2(NP.height3, x, z), h4: this.n2(NP.height4, x, z),
      hill_mnt: hterabs * hterabs * hterabs * nh * nh,
      ridge_mnt: rterabs * rterabs * rterabs * (1.0 - Math.abs(nr)),
      step_mnt: sterabs * sterabs * sterabs * steps(ns),
    };
  };
  Model.prototype.mountains = function (c, x, y, z) {
    const mv = N.noiseFractal3D(MV, x, y, z, this.seed);
    const lerp = (a, b, t) => a + t * (b - a);
    const hilliness = Math.max(Math.min(lerp(c.h1, c.h2, mv), lerp(c.h3, c.h4, mv)),
      Math.min(lerp(c.h3, c.h2, mv), lerp(c.h1, c.h4, mv)));
    return c.hill_mnt * hilliness + c.ridge_mnt * hilliness + c.step_mnt * hilliness;
  };
  // get_biome_override: 'DeepOcean', 'Ocean' or null.  (x, z) in Luanti coordinates.
  Model.prototype.biomeOverride = function (x, z) {
    const c = this.base(x, z);
    const y = WATER_LEVEL + 3;
    const grad = y < WATER_LEVEL ? GRAD_WL + (WATER_LEVEL - y) * 3 : 1 - y;
    const est = (12 + this.mountains(c, x, y, z) + grad) / 4;
    if (est < -20) return 'DeepOcean';
    if (est < -2) return 'Ocean';
    return null;
  };
  // get_column_height: first y above the ground as Mineclonia's model sees it.
  Model.prototype.columnHeight = function (x, z, liquidsSolid) {
    const c = this.base(x, z);
    const M = MAX_MNT_VAR_LUA;
    const sortlerp = (a, b) => { const m2 = a + M * (b - a), m1 = a + -M * (b - a); return [Math.max(m2, m1), Math.min(m1, m2)]; };
    const L1 = sortlerp(c.h1, c.h2), L2 = sortlerp(c.h3, c.h4), L3 = sortlerp(c.h3, c.h2), L4 = sortlerp(c.h4, c.h3);
    const hMax = Math.max(L1[0], L2[0], L3[0], L4[0]), hMin = Math.min(L1[1], L2[1], L3[1], L4[1]);
    const mMax = c.hill_mnt * hMax + c.ridge_mnt * hMax + c.step_mnt * hMax;
    const mMin = c.hill_mnt * hMin + c.ridge_mnt * hMin + c.step_mnt * hMin;
    const yMax = Math.ceil((12 + Math.max(mMax, mMin) + 1) / 2);
    if (liquidsSolid && yMax <= WATER_LEVEL) return WATER_LEVEL + 1;
    let yMin = Math.floor((12 + Math.min(mMin, mMax) + 2) / 2);
    let valley = 1.0, river = 0.0;
    if (this.flags.rivers) {
      river = Math.abs(this.n2(NP.rivers, x, z)) - 0.05;
      if (river <= 0.25) {
        if (river < 0.0) valley = river;
        else { const sc = river / 0.25; valley = sc * sc * (3.0 - 2.0 * sc); }
        if (valley < 0.0) yMin = Math.min(yMin, Math.floor(WATER_LEVEL - Math.sqrt(-valley) * 24));
        else yMin = Math.min(yMin, -128);
      }
    }
    for (let y = yMax; y >= yMin; y--) {
      const grad = y < WATER_LEVEL ? GRAD_WL + (WATER_LEVEL - y) * 3 : 1 - y;
      let s = 12 + this.mountains(c, x, y, z) + grad;
      if (this.flags.rivers && river <= 0.25) {
        if (valley < 0.0) s = Math.min(s, WATER_LEVEL - Math.sqrt(-valley) * 24);
        else if (s > WATER_LEVEL) s = WATER_LEVEL + (s - WATER_LEVEL) * valley;
      }
      if (y < s) return y + 1;
      if (y <= WATER_LEVEL && liquidsSolid) return y + 1;
    }
    return yMin;
  };

  const api = { NP, WATER_LEVEL, parseFlags, getSteps, columnShape, surfaceLevel, generateChunkTop, spawnLevel, Model };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LuantiCarpathian = api;
})(typeof self !== 'undefined' ? self : this);
