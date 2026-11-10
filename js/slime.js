// Slime chunks, as Mineclonia decides them (mcl_biome_dispatch
// is_slime_chunk and mcl_levelgen set_slime_chunk_seed in random.lua, the
// same formula as Minecraft's).  Outside swamps, slimes spawn only in these
// 16 x 16 chunks, at Y -24 and below.  Mineclonia's chunk grid has z
// flipped: chunk (cx, cz) holds Luanti x in [cx*16, cx*16+15] and
// -z-1 in [cz*16, cz*16+15].
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const V = isNode ? require('./villages.js') : root.MclVillages;
  const M64 = (1n << 64n) - 1n;
  const SALT = 0x3ad8025fn;
  const i32 = (v) => BigInt(Math.imul(Number(BigInt.asIntN(32, v)), 1)); // sign-extended low 32 bits
  function Slime(levelSeed) {
    this.levelSeed = BigInt(levelSeed);
    this.rng = new V.JavaRandom(0n);
  }
  Slime.prototype.isChunk = function (cx, cz) {
    const x = BigInt(cx), z = BigInt(cz);
    let s = this.levelSeed;
    s += i32(i32(x * x) * 0x4c1906n);
    s += i32(x * 0x5ac0dbn);
    s += i32(z * z) * 0x4307a7n;
    s += i32(z * 0x5f24fn);
    this.rng.reseed((s & M64) ^ SALT);
    return this.rng.nextWithin(10) === 0;
  };
  Slime.prototype.at = function (x, z) {
    return this.isChunk(Math.floor(x / 16), Math.floor((-z - 1) / 16));
  };
  const api = { Slime };
  if (isNode) module.exports = api;
  else root.MclSlime = api;
})(typeof self !== 'undefined' ? self : this);
