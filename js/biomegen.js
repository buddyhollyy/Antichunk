// Port of Luanti's biome selection (src/mapgen/mg_biome.cpp,
// BiomeGenOriginal) for use with the v7 surface heights from v7.js.
// Luanti is LGPL-2.1-or-later.
//
// In MapgenBasic::generateBiomes the biome stored for a column is the one
// calculated at the highest stone node. (For water-covered columns it is
// first calculated at the water surface, y = 1, and then recalculated at
// the stone below because every Mineclonia ocean biome boundary sits at
// y <= 0.) So: biome = calcBiomeFromNoise(heat, humidity, (x, top, z)).
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const N = isNode ? require('./noise.js') : root.LuantiNoise;
  const DATA = isNode ? require('./biomes-data.js') : root.MclBiomes;
  const fr = Math.fround;
  const LIMIT = 31007; // MAX_MAP_GENERATION_LIMIT

  // mg_biome_np_* defaults (BiomeParamsOriginal in mg_biome.h).
  const NP = {
    heat:           N.NP(50, 50,  [1000, 1000, 1000], 5349,  3, 0.5, 2.0),
    humidity:       N.NP(50, 50,  [1000, 1000, 1000], 842,   3, 0.5, 2.0),
    heat_blend:     N.NP(0,  1.5, [8, 8, 8],          13,    2, 1.0, 2.0),
    humidity_blend: N.NP(0,  1.5, [8, 8, 8],          90003, 2, 1.0, 2.0),
  };

  // Biome list as the engine stores it: index 0 is the built-in "default"
  // biome (BIOME_NONE), then Mineclonia's biomes in registration order.
  const BIOMES = [{ name: 'default' }].concat(DATA.biomes.map((b) => ({
    name: b.name,
    heat: fr(b.heat_point), humidity: fr(b.humidity_point),
    ymin: b.y_min, ymax: b.y_max,
    vblend: b.vertical_blend, weight: fr(b.weight),
    type: b._mcl_biome_type || null,
  })));

  // ---------------------------------------------------------------- PcgRandom
  const M64 = (1n << 64n) - 1n;
  const PCG_MUL = 6364136223846793005n;
  const PCG_SEQ = 0xda3e39cb94b95bdbn;
  function Pcg(state) {
    this.inc = ((PCG_SEQ << 1n) | 1n) & M64;
    this.state = 0n;
    this.next();
    this.state = (this.state + (state & M64)) & M64;
    this.next();
  }
  Pcg.prototype.next = function () {
    const old = this.state;
    this.state = (old * PCG_MUL + this.inc) & M64;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
  };
  Pcg.prototype.range = function (min, max) {
    const bound = (max - min + 1) >>> 0;
    let r;
    if (bound === 0) r = this.next();
    else if (bound === 1) r = 0;
    else {
      const threshold = ((0x100000000 - bound) >>> 0) % bound; // u32: -bound % bound
      while ((r = this.next()) < threshold);
      r = r % bound;
    }
    return (r + min) | 0;
  };

  // ---------------------------------------------------------------- selection
  function calcBiomeFromNoise(heat, humidity, x, y, z) {
    let closest = 0, closestBlend = 0;
    let distMin = 3.4028234663852886e38, distMinBlend = 3.4028234663852886e38; // FLT_MAX
    for (let i = 1; i < BIOMES.length; i++) {
      const b = BIOMES[i];
      if (y < b.ymin || y > b.ymax + b.vblend ||
          x < -LIMIT || x > LIMIT || z < -LIMIT || z > LIMIT) continue;
      const dh = fr(heat - b.heat), du = fr(humidity - b.humidity);
      let dist = fr(fr(dh * dh) + fr(du * du));
      if (b.weight > 0) dist = fr(dist / b.weight);
      if (y <= b.ymax) {
        if (dist < distMin) { distMin = dist; closest = i; }
      } else if (dist < distMinBlend) {
        distMinBlend = dist; closestBlend = i;
      }
    }
    if (closestBlend) {
      // const u64 seed = static_cast<s64>(pos.Y + (heat + humidity) * 0.9f);
      const f = fr(y + fr(fr(heat + humidity) * fr(0.9)));
      const seed = BigInt.asUintN(64, BigInt(Math.trunc(f)));
      if (distMinBlend <= distMin) {
        const rng = new Pcg(seed);
        if (rng.range(0, BIOMES[closestBlend].vblend) >= y - BIOMES[closestBlend].ymax) return closestBlend;
      }
    }
    return closest; // 0 = default biome
  }

  // Biome index for every sampled column of a chunk, given the top-solid
  // heights from LuantiV7.generateChunkTop (same cx, cz, step).
  // With no surface, every column is looked up at height y (the Nether).
  function chunkBiomes(seed, cx, cz, step, surface, y) {
    const S = 80, m = Math.ceil(S / step);
    const heat = N.noiseMap2D(NP.heat, seed, cx, cz, S, S, null, step);
    const hum = N.noiseMap2D(NP.humidity, seed, cx, cz, S, S, null, step);
    const heatB = N.noiseMap2D(NP.heat_blend, seed, cx, cz, S, S, null, step);
    const humB = N.noiseMap2D(NP.humidity_blend, seed, cx, cz, S, S, null, step);
    const out = new Uint8Array(m * m);
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const i = kk * m + ii;
      out[i] = calcBiomeFromNoise(fr(heat[i] + heatB[i]), fr(hum[i] + humB[i]),
        cx + ii * step, surface ? surface[i] : y, cz + kk * step);
    }
    return out;
  }

  const api = { NP, BIOMES, Pcg, calcBiomeFromNoise, chunkBiomes };
  if (isNode) module.exports = api;
  else root.LuantiBiomes = api;
})(typeof self !== 'undefined' ? self : this);
