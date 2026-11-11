// Where Luanti puts new players, ported from Luanti (LGPL-2.1-or-later):
// Server::findSpawnPos (src/server.cpp) and getSpawnLevelAtPoint of each
// map generator (src/mapgen/mapgen_v7.cpp; the others are in v5.js,
// flat.js, valleys.js and carpathian.js).
//
// Mineclonia keeps the engine's choice in all of these map generators.  The engine tries
// random points in a square round 0,0 that grows by one node per try,
// and takes the first point that is dry land no higher than y 17 and not
// in a river.  The random numbers are not tied to the seed, so the exact
// spot can differ from player to player; the map marks the suitable point
// nearest 0,0 and the area where new players can appear.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const N = isNode ? require('./noise.js') : root.LuantiNoise;
  const V7 = isNode ? require('./v7.js') : root.LuantiV7;
  const fr = Math.fround;
  const NP = V7.NP;
  const WATER_LEVEL = 1, MAX_SPAWN_Y = 17;

  const F = isNode ? require('./flat.js') : root.LuantiFlat;
  // mapgen: 'v7' (default) or a Flat spec such as 'flat:lakes'.
  function Spawn(seed32, mapgen) {
    this.seed = seed32; this.cache = new Map();
    this.flat = String(mapgen || 'v7').startsWith('flat') ? F.parseFlags(mapgen) : null;
    this.valleys = String(mapgen || 'v7').startsWith('valleys');
    this.v5 = mapgen === 'v5';
    this.carp = String(mapgen || 'v7').startsWith('carpathian')
      ? (isNode ? require('./carpathian.js') : root.LuantiCarpathian).parseFlags(mapgen) : null;
  }
  Spawn.prototype.n2 = function (np, x, z) { return N.noiseFractal2D(np, x, z, this.seed); };

  // baseTerrainLevelAtPoint (single-precision floats, as in C++).
  Spawn.prototype.base = function (x, z) {
    let hselect = this.n2(NP.height_select, x, z);
    hselect = Math.min(Math.max(hselect, 0), 1);
    const persist = this.n2(NP.terrain_persist, x, z);
    const hb = this.n2(Object.assign({}, NP.terrain_base, { persist }), x, z);
    const ha = this.n2(Object.assign({}, NP.terrain_alt, { persist }), x, z);
    if (ha > hb) return ha;
    return fr(fr(hb * hselect) + fr(ha * fr(1 - hselect)));
  };
  Spawn.prototype.mountain = function (x, y, z) {
    const mh = Math.max(this.n2(NP.mount_height, x, z), 1);
    const grad = -fr(y / mh);
    return fr(N.noiseFractal3D(NP.mountain, x, y, z, this.seed) + grad) >= 0;
  };
  // getSpawnLevelAtPoint: spawn y, or null when unsuitable.
  Spawn.prototype.level = function (x, z) {
    const key = x + ',' + z;
    if (this.cache.has(key)) return this.cache.get(key);
    let out = null;
    if (this.flat) out = F.spawnLevel(this.seed, x, z, this.flat);
    else if (this.v5) out = (isNode ? require('./v5.js') : root.LuantiV5).spawnLevel(this.seed, x, z);
    else if (this.carp) out = (isNode ? require('./carpathian.js') : root.LuantiCarpathian).spawnLevel(this.seed, x, z, this.carp);
    else if (this.valleys) out = (isNode ? require('./valleys.js') : root.LuantiValleys).spawnLevel(this.seed, x, z);
    else if (Math.abs(fr(this.n2(NP.ridge_uwater, x, z) * 2)) > 0.2) {
      let y = Math.trunc(this.base(x, z));
      for (let iters = 256; iters > 0 && y <= MAX_SPAWN_Y; iters--, y++) {
        if (!this.mountain(x, y + 1, z)) { out = y <= WATER_LEVEL ? null : y + 1; break; }
      }
    }
    this.cache.set(key, out);
    return out;
  };

  // The suitable point nearest 0,0 (by the square distance the engine
  // searches with), and the size of the square where new players can
  // appear (estimated by repeating the engine's search with random
  // numbers).
  // Rings searched for the nearest point: a wider search takes seconds in
  // Valleys worlds, where 0,0 is often far from any suitable point.
  const RINGS = 150;
  Spawn.prototype.find = function (trials) {
    let nearest = null;
    for (let r = 0; r <= RINGS && !nearest; r++) {
      let best = null;
      for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== r) continue;
        const y = this.level(x, z);
        if (y === null) continue;
        const d = x * x + z * z;
        if (!best || d < best.d) best = { x, z, y, d };
      }
      nearest = best;
    }
    let reach = 0;
    const hits = [];
    let far = null; // closest suitable point the random runs found
    for (let t = 0; t < (trials || 200); t++) {
      for (let i = 0; i < 4000; i++) {
        const range = 1 + i;
        const x = -range + Math.floor(Math.random() * (range * 2 + 1));
        const z = -range + Math.floor(Math.random() * (range * 2 + 1));
        if (this.level(x, z) === null) continue;
        hits.push([x, z]);
        reach = Math.max(reach, Math.abs(x), Math.abs(z));
        const d = x * x + z * z;
        if (!far || d < far.d) far = { x, z, y: this.level(x, z), d, fromRuns: true };
        break;
      }
    }
    // In some Valleys worlds no point within RINGS nodes of 0,0 is
    // suitable; then show the closest point the random runs found instead.
    if (!nearest) nearest = far;
    return { nearest, reach, hits };
  };

  const api = { Spawn, RINGS };
  if (isNode) module.exports = api;
  else root.LuantiSpawn = api;
})(typeof self !== 'undefined' ? self : this);
