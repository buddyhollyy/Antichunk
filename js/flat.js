// The Flat map generator, ported from Luanti (LGPL-2.1-or-later) and
// Mineclonia (GPL-3.0):
//   src/mapgen/mapgen_flat.cpp   MapgenFlat::generateTerrain and
//                                getSpawnLevelAtPoint (Luanti)
//   src/mapgen/mapgen_flat.h     default settings (Luanti)
//   mods/MAPGEN/mcl_mapgen_models/flat.lua   Mineclonia's model of Flat,
//                                which it uses to place structures
//
// Flat ground at y 8.  Two optional features, picked when the world is
// made ("Lakes" and "Hills" in Luanti's Create World dialog, setting
// mgflat_spflags, both off by default), dig lakes and raise hills where
// one 2D noise is low or high.  Everything else (biomes, caves, trees) is
// the same as in other map generators.  Mineclonia's "classic superflat"
// option is a different world and is not handled here.
(function (root) {
  'use strict';
  const N = (typeof module !== 'undefined' && module.exports) ? require('./noise.js') : root.LuantiNoise;
  const fr = Math.fround;

  const CHUNK = 80;
  const WATER_LEVEL = 1;
  const GROUND_LEVEL = 8;
  // MapgenFlatParams defaults (C++ floats).
  const LAKE_THRESHOLD = fr(-0.45), LAKE_STEEPNESS = fr(48.0);
  const HILL_THRESHOLD = fr(0.45), HILL_STEEPNESS = fr(64.0);
  const NP = { terrain: N.NP(0, 1, [600, 600, 600], 7244, 5, 0.6, 2.0) };

  // "flat", "flat:lakes", "flat:hills" or "flat:lakes,hills" -> flags.
  function parseFlags(spec) {
    const list = String(spec || '').split(':')[1] || '';
    const set = new Set(list.split(',').map((s) => s.trim()));
    return { lakes: set.has('lakes'), hills: set.has('hills') };
  }

  // Stone level of a column from the terrain noise value (single-precision
  // floats and an s16 cast, as in generateTerrain).
  function stoneLevel(n, flags) {
    if (flags.lakes && n < LAKE_THRESHOLD) {
      return GROUND_LEVEL - Math.trunc(fr(fr(LAKE_THRESHOLD - n) * LAKE_STEEPNESS));
    }
    if (flags.hills && n > HILL_THRESHOLD) {
      return GROUND_LEVEL + Math.trunc(fr(fr(n - HILL_THRESHOLD) * HILL_STEEPNESS));
    }
    return GROUND_LEVEL;
  }

  // Same output as LuantiV7.generateChunkTop: per column the top solid y
  // and whether water sits on it.
  function generateChunkTop(seed, cx, cz, step, flags) {
    step = step || 1;
    const m = Math.ceil(CHUNK / step), n = m * m;
    const noise = (flags.lakes || flags.hills)
      ? N.noiseMap2D(NP.terrain, seed, cx, cz, CHUNK, CHUNK, null, step) : null;
    const surface = new Int16Array(n), water = new Uint8Array(n);
    for (let idx = 0; idx < n; idx++) {
      const top = stoneLevel(noise ? noise[idx] : 0, flags);
      surface[idx] = top;
      water[idx] = top < WATER_LEVEL ? 1 : 0;
    }
    return { size: m, step, surface, water, base: surface };
  }

  // getSpawnLevelAtPoint: spawn y, or null when unsuitable (under water).
  function spawnLevel(seed, x, z, flags) {
    const n = (flags.lakes || flags.hills) ? N.noiseFractal2D(NP.terrain, x, z, seed) : 0;
    const stone = stoneLevel(n, flags);
    return stone >= WATER_LEVEL ? stone + 2 : null;
  }

  // Mineclonia's model (flat.lua).  Lua numbers are doubles, so the
  // arithmetic here is in double precision on the single-point noise.
  function Model(seed32, flags) { this.seed = seed32; this.flags = flags; }
  Model.prototype.noise = function (x, z) {
    return (this.flags.lakes || this.flags.hills) ? N.noiseFractal2D(NP.terrain, x, z, this.seed) : 0.0;
  };
  // get_biome_override: 'DeepOcean', 'Ocean' or null.  (x, z) in Luanti coordinates.
  Model.prototype.biomeOverride = function (x, z) {
    if (!this.flags.lakes) return null;
    const n = this.noise(x, z);
    if (n < -0.45) {
      const stone = GROUND_LEVEL - Math.trunc((-0.45 - n) * 48.0);
      if (stone < -16) return 'DeepOcean';
      if (stone < -3) return 'Ocean';
    }
    return null;
  };
  // get_column_height: first y above the ground as Mineclonia's model sees it.
  Model.prototype.columnHeight = function (x, z, liquidsSolid) {
    const n = this.noise(x, z);
    let stone = GROUND_LEVEL;
    if (this.flags.lakes && n < -0.45) stone -= Math.trunc((-0.45 - n) * 48.0);
    else if (this.flags.hills && n > 0.45) stone += Math.trunc((n - 0.45) * 64.0);
    return liquidsSolid ? Math.max(stone, WATER_LEVEL) + 1 : stone + 1;
  };

  const api = { NP, GROUND_LEVEL, WATER_LEVEL, parseFlags, stoneLevel, generateChunkTop, spawnLevel, Model };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LuantiFlat = api;
})(typeof self !== 'undefined' ? self : this);
