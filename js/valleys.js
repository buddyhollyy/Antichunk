// The Valleys map generator, ported from Luanti (LGPL-2.1-or-later) and
// Mineclonia (GPL-3.0):
//   src/mapgen/mapgen_valleys.cpp  MapgenValleys::generateTerrain and
//                                  getSpawnLevelAtPoint (Luanti)
//   src/mapgen/mapgen_valleys.h    default settings (Luanti)
//   mods/MAPGEN/mcl_mapgen_models/valleys.lua   Mineclonia's model of
//                                  Valleys, which it uses to place structures
//
// Rivers run along the bottom of valleys cut into rolling land.  The
// ground shape comes from 2D noises plus one 3D noise ("inter valley
// fill") that makes overhangs on the valley sides.  Four options, picked
// when the world is made and all on by default (setting
// mgvalleys_spflags), also change heat and humidity, and so biomes:
//   altitude_chill    colder higher up
//   altitude_dry      drier higher up
//   humid_rivers      more humid near rivers
//   vary_river_depth  shallower or dry rivers where it is hot and dry
// Other settings are assumed to be the defaults (altitude_chill 90,
// river_depth 4, river_size 5, water_level 1, chunksize 5).
(function (root) {
  'use strict';
  const N = (typeof module !== 'undefined' && module.exports) ? require('./noise.js') : root.LuantiNoise;
  const BG = (typeof module !== 'undefined' && module.exports) ? require('./biomegen.js') : root.LuantiBiomes;
  const fr = Math.fround;

  const CHUNK = 80, CHUNK_OFFSET = -32;
  const WATER_LEVEL = 1;
  const ALTITUDE_CHILL = fr(90);
  const RIVER_DEPTH_BED = fr(4 + 1.0);            // river_depth + 1
  const RIVER_SIZE_FACTOR = fr(5 / 100.0);        // river_size / 100 (float)
  const FLAG_NAMES = ['altitude_chill', 'humid_rivers', 'vary_river_depth', 'altitude_dry'];

  const NP = {
    inter_valley_fill:  N.NP(0.0,   1.0,  [256, 512, 256],    1993,  6, 0.8, 2.0),
    inter_valley_slope: N.NP(0.5,   0.5,  [128, 128, 128],    746,   1, 1.0, 2.0),
    rivers:             N.NP(0.0,   1.0,  [256, 256, 256],    -6050, 5, 0.6, 2.0),
    terrain_height:     N.NP(-10.0, 50.0, [1024, 1024, 1024], 5202,  6, 0.4, 2.0),
    valley_depth:       N.NP(5.0,   4.0,  [512, 512, 512],    -1914, 1, 1.0, 2.0),
    valley_profile:     N.NP(0.6,   0.50, [512, 512, 512],    777,   1, 1.0, 2.0),
  };

  // "valleys" (all four options on, the default), "valleys:none" or
  // "valleys:altitude_chill,humid_rivers" (only those on) -> flags.
  function parseFlags(spec) {
    const parts = String(spec || 'valleys').split(':');
    const flags = {};
    if (parts.length < 2) { for (const f of FLAG_NAMES) flags[f] = true; return flags; }
    const on = new Set(parts[1].split(',').map((s) => s.trim()));
    for (const f of FLAG_NAMES) flags[f] = on.has(f);
    return flags;
  }
  function specOf(flags) {
    const on = FLAG_NAMES.filter((f) => flags[f]);
    if (on.length === FLAG_NAMES.length) return 'valleys';
    return 'valleys:' + (on.length ? on.join(',') : 'none');
  }

  function chunkOrigin(v) {
    return Math.floor((v - CHUNK_OFFSET) / CHUNK) * CHUNK + CHUNK_OFFSET;
  }
  // Largest possible inter_valley_fill value (sum of the octave weights),
  // and how fast it can change per node in y.
  const FILL = NP.inter_valley_fill;
  const FILL_REST = [], FILL_DY = (() => {
    const gs = []; let g = 1, f = 1, dy = 0;
    for (let o = 0; o < FILL.octaves; o++) { gs.push(g); dy += g * 2 * f / FILL.spread[1]; g *= FILL.persist; f *= FILL.lacunarity; }
    for (let o = 0; o < gs.length; o++) FILL_REST.push(gs.slice(o + 1).reduce((a, b) => a + b, 0) * 1.0001);
    return dy * 1.0001;
  })();
  const FILL_MAX = FILL_REST[0] + 1.0001;

  // The per-column part of generateTerrain before the vertical loop, in
  // single-precision floats as in C++.  heat and hum are the biome noise
  // values (heat + heat_blend, humidity + humidity_blend).
  function columnShape(n_slope, n_rivers, n_terrain_height, n_valley, n_valley_profile, heat, hum, flags) {
    const valley_d = fr(n_valley * n_valley);
    const base = fr(n_terrain_height + valley_d);
    const river = fr(Math.abs(n_rivers) - RIVER_SIZE_FACTOR);
    const tv = Math.max(fr(river / n_valley_profile), 0);
    const valley_h = fr(valley_d * fr(1 - fr(Math.exp(-fr(tv * tv)))));
    let surface_y = fr(base + valley_h);
    let slope = fr(n_slope * valley_h);
    let river_y = fr(base - 1);
    if (river < 0) {
      const tr = fr(fr(river / RIVER_SIZE_FACTOR) + 1);
      const depth = fr(RIVER_DEPTH_BED * fr(Math.sqrt(Math.max(0, fr(1 - fr(tr * tr))))));
      surface_y = Math.min(Math.max(fr(base - depth), WATER_LEVEL - 3), surface_y);
      slope = 0;
    }
    if (flags && flags.vary_river_depth) {
      const h = flags.altitude_chill
        ? fr(fr(heat + 5) - fr(fr(fr(base - WATER_LEVEL) * 20) / ALTITUDE_CHILL)) : heat;
      const delta = fr(hum - 50);
      if (delta < 0) {
        const t_evap = fr(fr(h - 32) / 300);
        river_y = fr(river_y + fr(delta * Math.max(t_evap, fr(0.08))));
      }
    }
    return { base, surface_y, slope, river_y };
  }

  // Heat and humidity after the options (end of generateTerrain).
  function adjustClimate(heat, hum, base, columnMaxY, flags) {
    const t_alt = Math.max(base, columnMaxY);
    if (flags.humid_rivers) {
      hum = fr(hum * fr(0.8));
      const water_depth = fr(fr(t_alt - base) / 4);
      hum = fr(hum * fr(1 + fr(Math.pow(0.5, Math.max(water_depth, 1)))));
    }
    if (flags.altitude_dry && t_alt > WATER_LEVEL) {
      hum = fr(hum - fr(fr(fr(t_alt - WATER_LEVEL) * 10) / ALTITUDE_CHILL));
    }
    if (flags.altitude_chill) {
      heat = fr(heat + 5);
      if (t_alt > WATER_LEVEL) heat = fr(heat - fr(fr(fr(t_alt - WATER_LEVEL) * 20) / ALTITUDE_CHILL));
    }
    return [heat, hum];
  }

  // 3D noise maps are cached per mapchunk (y origin) for one column of chunks.
  function FillCache(seed, cx, cz) { this.seed = seed; this.cx = cx; this.cz = cz; this.maps = new Map(); }
  FillCache.prototype.get = function (cy) {
    let m = this.maps.get(cy);
    if (!m) {
      m = new N.NoiseMap3D(FILL, this.seed, this.cx, cy - 1, this.cz, CHUNK, CHUNK + 2, CHUNK);
      this.maps.set(cy, m);
    }
    return m;
  };

  // Top solid y of one column: density = slope * n_fill - (y - surface_y) > 0.
  function topSolid(fills, i, k, c) {
    const s = c.surface_y, slope = c.slope;
    if (slope === 0) return Math.ceil(s) - 1;      // solid exactly where y < surface_y
    const reach = slope * FILL_MAX;
    const eps = 1e-3 * (1 + slope * FILL_MAX);
    const yHi = Math.floor(s + reach) + 1, yLo = Math.ceil(s - reach) - 1;
    const cols = new Map(); // per chunk: lattice cache for this column
    for (let y = yHi; y > yLo; y--) {
      const cy = chunkOrigin(y), j = y - (cy - 1);
      const m = fills.get(cy);
      let cc = cols.get(cy);
      if (!cc) { cc = []; cols.set(cy, cc); }
      const delta = y - s;
      let r = 0, decided = 0;
      for (let o = 0; o < FILL.octaves - 1; o++) {
        r += m.oct[o].g * m.octaveValueCol(o, i, j, k, cc);
        const best = slope * (r + FILL_REST[o]) - delta;
        if (best < -eps) {
          // Going down d nodes raises the density by at most d * (slope * FILL_DY + 1).
          const d = Math.floor((-best - eps) / (slope * FILL_DY + 1));
          if (d > 1) y -= d - 1;
          decided = -1; break;
        }
        if (slope * (r - FILL_REST[o]) - delta > eps) { decided = 1; break; }
      }
      if (decided === 1) return y;
      if (decided === -1) continue;
      const nfill = m.getCol(i, j, k, cc);
      if (fr(fr(slope * nfill) - fr(y - s)) > 0) return y;
    }
    return yLo;
  }

  // Same output as LuantiV7.generateChunkTop, plus the heat and humidity
  // each column's biome is picked with (changed by the options).
  function generateChunkTop(seed, cx, cz, step, flags) {
    step = step || 1;
    const S = CHUNK, m = Math.ceil(S / step), n = m * m;
    const map = (np) => N.noiseMap2D(np, seed, cx, cz, S, S, null, step);
    const nSlope = map(NP.inter_valley_slope), nRivers = map(NP.rivers), nTerrain = map(NP.terrain_height);
    const nValley = map(NP.valley_depth), nProfile = map(NP.valley_profile);
    const hA = map(BG.NP.heat), hB = map(BG.NP.heat_blend), uA = map(BG.NP.humidity), uB = map(BG.NP.humidity_blend);
    const fills = new FillCache(seed, cx, cz);
    const surface = new Int16Array(n), water = new Uint8Array(n);
    const heat = new Float32Array(n), hum = new Float32Array(n);
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const idx = kk * m + ii;
      const h0 = fr(hA[idx] + hB[idx]), u0 = fr(uA[idx] + uB[idx]);
      const c = columnShape(nSlope[idx], nRivers[idx], nTerrain[idx], nValley[idx], nProfile[idx], h0, u0, flags);
      const top = topSolid(fills, ii * step, kk * step, c);
      surface[idx] = top;
      // Sea water up to water_level, river water up to (s16)river_y.
      water[idx] = (top < WATER_LEVEL || top + 1 <= Math.trunc(c.river_y)) ? 1 : 0;
      // column_max_y in the mapchunk that holds the top node.
      const colMax = Math.max(Math.trunc(c.surface_y), top);
      [heat[idx], hum[idx]] = adjustClimate(h0, u0, c.base, colMax, flags);
    }
    return { size: m, step, surface, water, base: surface, heat, hum };
  }

  // Biome of each column, as generateBiomes picks it.
  function chunkBiomes(r, cx, cz) {
    const m = r.size, out = new Uint8Array(m * m);
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const i = kk * m + ii;
      out[i] = BG.calcBiomeFromNoise(r.heat[i], r.hum[i], cx + ii * r.step, r.surface[i], cz + kk * r.step);
    }
    return out;
  }

  // getSpawnLevelAtPoint: spawn y, or null when unsuitable.
  function spawnLevel(seed, x, z) {
    const n_rivers = N.noiseFractal2D(NP.rivers, x, z, seed);
    if (Math.abs(n_rivers) <= RIVER_SIZE_FACTOR) return null;
    const p = (np) => N.noiseFractal2D(np, x, z, seed);
    const c = columnShape(p(NP.inter_valley_slope), n_rivers, p(NP.terrain_height), p(NP.valley_depth),
      p(NP.valley_profile), 0, 0, null);
    // fmax(terrain_height offset + valley_depth offset ^ 2, water_level + 16) = 17
    const maxSpawnY = Math.trunc(Math.max(fr(NP.terrain_height.offset + fr(NP.valley_depth.offset * NP.valley_depth.offset)),
      WATER_LEVEL + 16));
    // Quick answers without the 3D noise: every node below
    // surface_y - slope * FILL_MAX is solid, none above surface_y +
    // slope * FILL_MAX is.  If the whole band is above max_spawn_y the
    // first solid node is too high; if it is below water_level there is none.
    if (c.surface_y - c.slope * FILL_MAX - 2 > maxSpawnY) return null;
    if (c.surface_y + c.slope * FILL_MAX + 2 < WATER_LEVEL) return null;
    // No node above surface_y + slope * FILL_MAX can be solid, so start there.
    const start = Math.min(maxSpawnY + 128, Math.floor(c.surface_y + c.slope * FILL_MAX) + 2);
    for (let y = start; y >= WATER_LEVEL; y--) {
      const nfill = N.noiseFractal3D(FILL, x, y, z, seed);
      if (fr(fr(c.slope * nfill) - fr(y - c.surface_y)) > 0) {
        if (y < WATER_LEVEL || y > maxSpawnY || y < Math.trunc(c.river_y)) return null;
        return y + 2;
      }
    }
    return null;
  }

  // Mineclonia's model (valleys.lua).  Lua numbers are doubles, so the
  // arithmetic here is in double precision on the single-point noise.
  // One difference: Mineclonia reads heat and humidity for
  // vary_river_depth at a Z left over from an earlier call (it reuses one
  // position table); this uses the column's own Z.
  const FILL_MAX_LUA = (() => { let a = 1.0, g = 1.0; for (let i = 0; i < FILL.octaves; i++) { a += g; g *= FILL.persist; } return FILL.offset + a * FILL.scale; })();
  function Model(seed32, flags) { this.seed = seed32; this.flags = flags; }
  Model.prototype.n2 = function (np, x, z) { return N.noiseFractal2D(np, x, z, this.seed); };
  Model.prototype.shape = function (x, z) {
    const river_size_factor = 5 / 100.0, river_depth_bed = 4 + 1.0;
    const n_slope = this.n2(NP.inter_valley_slope, x, z);
    const n_rivers = this.n2(NP.rivers, x, z);
    const n_terrain_height = this.n2(NP.terrain_height, x, z);
    const n_valley = this.n2(NP.valley_depth, x, z);
    const n_valley_profile = this.n2(NP.valley_profile, x, z);
    const valley_d = n_valley * n_valley;
    const base = n_terrain_height + valley_d;
    const river = Math.abs(n_rivers) - river_size_factor;
    const tv = Math.max(river / n_valley_profile, 0.0);
    const valley_h = valley_d * (1.0 - Math.exp(-tv * tv));
    let surface_y = base + valley_h;
    let slope = n_slope * valley_h;
    let river_y = base - 1.0;
    if (river < 0.0) {
      const tr = river / river_size_factor + 1.0;
      const depth = river_depth_bed * Math.sqrt(Math.max(0.0, 1.0 - tr * tr));
      surface_y = Math.min(Math.max(base - depth, WATER_LEVEL - 3), surface_y);
      slope = 0.0;
    }
    return { base, est: base + valley_h, surface_y, slope, river_y };
  };
  // get_biome_override: 'DeepOcean', 'Ocean' or null.  (x, z) in Luanti coordinates.
  Model.prototype.biomeOverride = function (x, z) {
    const est = this.shape(x, z).est;
    if (est < WATER_LEVEL - 20) return 'DeepOcean';
    if (est < WATER_LEVEL) return 'Ocean';
    return null;
  };
  // get_column_height: first y above the ground as Mineclonia's model sees it.
  Model.prototype.columnHeight = function (x, z, liquidsSolid) {
    const c = this.shape(x, z);
    let river_y = c.river_y;
    if (this.flags.vary_river_depth) {
      const t_heat = fr(this.n2(BG.NP.heat, x, z) + this.n2(BG.NP.heat_blend, x, z));
      const heat = this.flags.altitude_chill ? t_heat + 5.0 - (c.base - WATER_LEVEL) * 20.0 / 90 : t_heat;
      const delta = fr(this.n2(BG.NP.humidity, x, z) + this.n2(BG.NP.humidity_blend, x, z)) - 50.0;
      if (delta < 0.0) river_y = river_y + delta * Math.max((heat - 32.0) / 300.0, 0.08);
    }
    const maxGradient = Math.ceil(FILL_MAX_LUA * c.slope);
    let colMax = Math.trunc(c.surface_y);
    if (liquidsSolid && colMax < WATER_LEVEL) colMax = WATER_LEVEL;
    const miny = colMax - maxGradient;
    for (let y = colMax + maxGradient; y >= miny; y--) {
      const nfill = N.noiseFractal3D(FILL, x, y, z, this.seed);
      if (c.slope * nfill - (y - c.surface_y) > 0.0) return y + 1;
      if (liquidsSolid && (y <= WATER_LEVEL || y <= river_y)) return y + 1;
    }
    return miny;
  };

  const api = { NP, FLAG_NAMES, WATER_LEVEL, parseFlags, specOf, columnShape, adjustClimate, generateChunkTop,
    chunkBiomes, spawnLevel, Model };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LuantiValleys = api;
})(typeof self !== 'undefined' ? self : this);
