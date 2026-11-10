// The End in Mineclonia v7 worlds, ported from Mineclonia (GPL-3.0) and
// Luanti (LGPL-2.1+):
//   mods/MAPGEN/mcl_biomes/init.lua       End biomes and the end stone
//                                         "stratum" ores that make the islands
//   mods/MAPGEN/mcl_end_island/init.lua   the central island
//   mods/MAPGEN/mcl_structures/end_spawn.lua, mods/ITEMS/mcl_portals/
//   portal_gateway.lua, mods/CORE/mcl_init/init.lua   fixed End features
//   src/mapgen/mg_ore.cpp (OreStratum), src/mapgen/mg_biome.cpp (Luanti)
//
// The End is a layer of the same Luanti world starting at y -27073.  Its
// biomes turn all terrain into air; the land is added afterward:
//  - within 200 nodes of 0,0, the central island (a 3D noise shape);
//  - inside the 1,300 x 1,300 square round 0,0 (biome EndIsland) nothing else;
//  - from there out to the 2,500 x 2,500 square (EndBorder), one layer of
//    end stone islands;
//  - beyond that (End), three overlapping layers.
// End biomes do not depend on the heat and humidity noise: EndIsland and
// EndBorder are limited to those squares and their heat/humidity points
// (50 and 500) are always nearer than the End biomes' (1000).
(function (root) {
  'use strict';
  const N = root.LuantiNoise || (typeof require !== 'undefined' ? require('./noise.js') : null);
  const fr = Math.fround;

  const END_MIN = -27073;
  const Y_MIN = END_MIN + 64, Y_MAX = END_MIN + 80;   // the strata's y range

  // Mineclonia writes some noise seeds as core.get_mapgen_setting("seed") + n.
  // The setting is the seed as a decimal string, so Lua turns it into a
  // double, adds n, and Luanti then reads the seed field with
  // lua_tointeger (to 64 bits) and keeps the low 32 bits.  Seeds of 2^63 and
  // above do not fit; on x86-64 the conversion gives -2^63, whose low 32
  // bits are 0.  (This is our reading of the code, not yet checked in game.)
  function luaSeed(seed64, add) {
    const d = Number(seed64) + add;
    const i64 = d >= 9223372036854775807 ? -(1n << 63n) : BigInt(Math.trunc(d));
    return Number(BigInt.asIntN(32, i64));
  }

  function strata(seed64) {
    const S = (n) => luaSeed(seed64, n);
    const NP = N.NP;
    return [
      { where: 'border', np: NP(END_MIN + 70, -1, [84, 84, 84], 145, 3, 0.6, 2),
        thick: NP(0, 15, [84, 84, 84], 145, 3, 0.6, 2) },
      { where: 'outer', np: NP(END_MIN + 70, -1, [126, 126, 126], S(9999), 3, 0.5, 2),
        thick: NP(-2, 10, [126, 126, 126], S(9999), 3, 0.5, 2) },
      { where: 'outer', np: NP(END_MIN + 72, -3, [84, 84, 84], S(999), 4, 0.8, 2),
        thick: NP(-4, 10, [84, 84, 84], S(999), 4, 0.8, 2) },
      { where: 'outer', np: NP(END_MIN + 70, -2, [84, 84, 84], S(99), 4, 0.85, 2),
        thick: NP(-3, 5, [63, 63, 63], S(50), 4, 0.85, 2) },
    ];
  }

  // Which End biome area a column is in.
  function area(x, z) {
    if (x >= -650 && x <= 650 && z >= -650 && z <= 650) return 'island';
    if (x >= -1250 && x <= 1250 && z >= -1250 && z <= 1250) return 'border';
    return 'outer';
  }

  // The central island (mcl_end_island): end stone where a 3D noise map
  // (401 x 30 x 401 samples from 0,0,0) beats a squashed-sphere falloff.
  // Mineclonia indexes the map as [x][y][z] but Luanti fills it as
  // [z][y][x], so noise X runs along world Z and the other way round.
  const W = 200;
  function Island(seed64) {
    this.map = new N.NoiseMap3D(N.NP(0.5, 0.5, [W + 10, W + 10, W + 10], luaSeed(seed64, 99999), 4, 0.85, 2),
      0, 0, 0, 0, 2 * W + 1, 30, 2 * W + 1);
  }
  // Top solid y of the island at (x, z), or null.
  Island.prototype.top = function (x, z) {
    if (x < -W || x > W || z < -W || z > W) return null;
    const ax = x / W, az = z / W, flat = ax * ax + az * az;
    const cache = [];
    for (let y = 25; y >= 4; y--) {
      const t = Math.abs(1 - y / 25);
      if (this.map.getCol(z + W, y, x + W, cache) > t * t + flat) return y + END_MIN + 46; // pos.y = y - 27027
    }
    return null;
  };

  // Top solid y of every sampled column of one 80 x 80 mapchunk (origin cx,
  // cz, every step-th node), from the strata only.  -32768 = none.
  function strataTops(seed64, cx, cz, step, list) {
    const m = Math.ceil(80 / step), out = new Int16Array(m * m).fill(-32768);
    const maps = list.map((s) => ({
      where: s.where,
      mid: N.noiseMap2D(s.np, 0, cx, cz, 80, 80, null, step),
      th: N.noiseMap2D(s.thick, 0, cx, cz, 80, 80, null, step),
    }));
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const i = kk * m + ii, a = area(cx + ii * step, cz + kk * step);
      if (a === 'island') continue;
      for (const s of maps) {
        if (s.where !== a) continue;
        const half = fr(s.th[i] / 2), mid = s.mid[i];
        const y0 = Math.max(Y_MIN, Math.ceil(fr(mid - half)));
        const y1 = Math.trunc(Math.min(Y_MAX, fr(mid + half))); // float to int: toward zero
        if (y0 <= y1 && y1 > out[i]) out[i] = y1;
      }
    }
    return out;
  }

  // Fixed features (same in every world).
  const PORTAL_Y = END_MIN + 75;
  const GATEWAYS = [[96, 0], [91, 29], [77, 56], [56, 77], [29, 91], [0, 96], [-29, 91], [-56, 77], [-77, 56],
    [-91, 29], [-96, 0], [-91, -29], [-77, -56], [-56, -77], [-29, -91], [0, -96], [29, -91], [56, -77],
    [77, -56], [91, -29]];
  const FEATURES = [
    { kind: 'end_portal', x: 0, y: END_MIN + 71, z: 0 },
    { kind: 'end_platform', x: 100, y: END_MIN + 48, z: 0 },
  ];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * (2 * Math.PI);
    FEATURES.push({ kind: 'end_spike', n: i + 1, x: Math.round(43 * Math.cos(a)), y: null, z: Math.round(43 * Math.sin(a)) });
  }
  GATEWAYS.forEach(([x, z], i) => FEATURES.push({ kind: 'end_gateway', n: i + 1, x, y: PORTAL_Y, z }));

  const api = { END_MIN, Y_MIN, Y_MAX, luaSeed, strata, area, Island, strataTops, FEATURES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MclEnd = api;
})(typeof self !== 'undefined' ? self : this);
