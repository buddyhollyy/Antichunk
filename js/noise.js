// Port of Luanti's value noise (src/noise.cpp) and seed parsing
// (src/util/string.cpp read_seed, src/util/numeric.cpp murmur_hash_64_ua).
// Luanti is LGPL-2.1-or-later; this port follows the same license.
//
// Every float operation is rounded with Math.fround so results match the
// engine's 32-bit float math bit-for-bit (on x86-64 builds).
(function (root) {
  'use strict';
  const fr = Math.fround;

  // ---------------------------------------------------------------- seeds

  // murmur_hash_64_ua(key, len, 0x1337), operating on UTF-8 bytes.
  function murmurHash64(bytes, seed) {
    const MASK = (1n << 64n) - 1n;
    const m = 0xc6a4a7935bd1e995n;
    const r = 47n;
    const len = BigInt(bytes.length);
    let h = (BigInt(seed) ^ (len * m)) & MASK;
    const nblocks = Math.floor(bytes.length / 8);
    for (let b = 0; b < nblocks; b++) {
      let k = 0n;
      for (let i = 7; i >= 0; i--) k = (k << 8n) | BigInt(bytes[b * 8 + i]); // little-endian
      k = (k * m) & MASK;
      k ^= k >> r;
      k = (k * m) & MASK;
      h ^= k;
      h = (h * m) & MASK;
    }
    const tail = nblocks * 8;
    const rem = bytes.length & 7;
    if (rem > 0) {
      for (let i = rem - 1; i >= 0; i--) h ^= BigInt(bytes[tail + i]) << BigInt(8 * i);
      h = (h * m) & MASK;
    }
    h ^= h >> r;
    h = (h * m) & MASK;
    h ^= h >> r;
    return h;
  }

  // strtoull-like parse. Returns {value, rest} where rest is the unparsed tail.
  function strtoull(str, base) {
    const MAX = (1n << 64n) - 1n;
    let i = 0;
    while (i < str.length && ' \t\n\v\f\r'.includes(str[i])) i++;
    let neg = false;
    if (str[i] === '+' || str[i] === '-') { neg = str[i] === '-'; i++; }
    if (base === 16 && str[i] === '0' && (str[i + 1] === 'x' || str[i + 1] === 'X') &&
        /[0-9a-fA-F]/.test(str[i + 2] || '')) i += 2;
    const digitRe = base === 16 ? /[0-9a-fA-F]/ : /[0-9]/;
    const start = i;
    let v = 0n, overflow = false;
    while (i < str.length && digitRe.test(str[i])) {
      v = v * BigInt(base) + BigInt(parseInt(str[i], base));
      if (v > MAX) overflow = true;
      i++;
    }
    if (i === start) return { value: 0n, rest: str }; // no conversion: endptr = str
    if (overflow) v = MAX;
    else if (neg) v = (-v) & MAX;
    return { value: v, rest: str.slice(i) };
  }

  // read_seed(): the 64-bit world seed from the text typed at world creation.
  function readSeed(str) {
    const isHex = str[0] === '0' && str[1] === 'x';
    const p = strtoull(str, isHex ? 16 : 10);
    if (p.rest.length > 0) return murmurHash64(new TextEncoder().encode(str), 0x1337);
    return p.value;
  }

  // Mapgen uses (s32)seed: the low 32 bits as a signed integer.
  function mapgenSeed(seed64) {
    return Number(BigInt.asIntN(32, BigInt(seed64)));
  }

  // ---------------------------------------------------------------- lattice

  function noise2d(x, y, seed) {
    let n = (Math.imul(1619, x) + Math.imul(31337, y) + Math.imul(1013, seed)) & 0x7fffffff;
    n = (n >>> 13) ^ n;
    const t = (Math.imul(Math.imul(n, n), 60493) + 19990303) | 0;
    n = (Math.imul(n, t) + 1376312589) & 0x7fffffff;
    return fr(1 - fr(n) / 0x40000000);
  }

  function noise3d(x, y, z, seed) {
    let n = (Math.imul(1619, x) + Math.imul(31337, y) + Math.imul(52591, z) +
      Math.imul(1013, seed)) & 0x7fffffff;
    n = (n >>> 13) ^ n;
    const t = (Math.imul(Math.imul(n, n), 60493) + 19990303) | 0;
    n = (Math.imul(n, t) + 1376312589) & 0x7fffffff;
    return fr(1 - fr(n) / 0x40000000);
  }

  function easeCurve(t) {
    // t * t * t * (t * (6.f * t - 15.f) + 10.f)
    const a = fr(fr(t * t) * t);
    const b = fr(fr(t * fr(fr(6 * t) - 15)) + 10);
    return fr(a * b);
  }

  function lerp(v0, v1, t) {
    return fr(v0 + fr(fr(v1 - v0) * t));
  }

  function biLerp(v00, v10, v01, v11, x, y, eased) {
    if (eased) { x = easeCurve(x); y = easeCurve(y); }
    const u = lerp(v00, v10, x);
    const v = lerp(v01, v11, x);
    return lerp(u, v, y);
  }

  function triLerp(v000, v100, v010, v110, v001, v101, v011, v111, x, y, z, eased) {
    if (eased) { x = easeCurve(x); y = easeCurve(y); z = easeCurve(z); }
    const u = biLerp(v000, v100, v010, v110, x, y, false);
    const v = biLerp(v001, v101, v011, v111, x, y, false);
    return lerp(u, v, z);
  }

  // ---------------------------------------------------------------- params

  const FLAG_DEFAULTS = 0x01, FLAG_EASED = 0x02, FLAG_ABSVALUE = 0x04;

  function NP(offset, scale, spread, seed, octaves, persist, lacunarity, flags) {
    return {
      offset: fr(offset), scale: fr(scale),
      spread: spread.map(fr), seed, octaves,
      persist: fr(persist), lacunarity: fr(lacunarity),
      flags: flags === undefined ? FLAG_DEFAULTS : flags,
    };
  }

  // ---------------------------------------------------------------- maps
  // Ports of Noise::noiseMap2D / noiseMap3D. These are what the engine uses
  // while generating a mapchunk, so they are the ones that must match.

  // One axis of a value map: for each sample index, which lattice cell it
  // falls in and the fractional position, accumulated the same way the
  // engine does (u += step; if (u >= 1) u -= 1).
  // Making new typed arrays costs far more than filling them, so 2D maps
  // fill shared scratch tables (out) and 3D maps share tables between maps
  // that need the same one (see axisTableShared).
  function axisTable(start, step, n, out) {
    const x0 = Math.floor(start);
    let u = fr(start - x0);
    const cell = out ? out.cell : new Int32Array(n), frac = out ? out.frac : new Float32Array(n);
    let c = 0;
    for (let i = 0; i < n; i++) {
      cell[i] = x0 + c;
      frac[i] = u;
      u = fr(u + step);
      if (u >= 1.0) { u = fr(u - 1); c++; }
    }
    return { cell, frac };
  }
  function scratch(t, n) {
    if (t.cell.length < n) { t.cell = new Int32Array(n); t.frac = new Float32Array(n); }
    return t;
  }
  const SX = { cell: new Int32Array(0), frac: new Float32Array(0) }, SY = { cell: new Int32Array(0), frac: new Float32Array(0) };
  const shared = new Map();
  function axisTableShared(start, step, n) {
    const k = start + '|' + step + '|' + n;
    let t = shared.get(k);
    if (!t) {
      if (shared.size > 20000) shared.clear();
      t = axisTable(start, step, n);
      shared.set(k, t);
    }
    return t;
  }

  function finish(np, result) {
    if (Math.abs(np.offset - 0) > 0.00001 || Math.abs(np.scale - 1) > 0.00001) {
      for (let i = 0; i < result.length; i++)
        result[i] = fr(fr(result[i] * np.scale) + np.offset);
    }
    return result;
  }

  // Returns Float32Array of sx*sy, index = y*sx + x  (y is the world Z axis).
  // With step > 1 only every step-th sample in each direction is computed
  // (same values as the full map at those points); the result is then
  // (sx/step) * (sy/step) and persistMap must be sampled the same way.
  function noiseMap2D(np, worldSeed, x, y, sx, sy, persistMap, step) {
    step = step || 1;
    const eased = (np.flags & (FLAG_DEFAULTS | FLAG_EASED)) !== 0;
    const abs = (np.flags & FLAG_ABSVALUE) !== 0;
    x = fr(x / np.spread[0]);
    y = fr(y / np.spread[1]);
    const mx = Math.ceil(sx / step), my = Math.ceil(sy / step);
    const n = mx * my;
    const result = new Float32Array(n);
    const gmap = persistMap ? new Float32Array(n).fill(1) : null;
    let f = fr(1), g = fr(1);
    for (let oct = 0; oct < np.octaves; oct++) {
      const s = (worldSeed + np.seed + oct) | 0;
      const ax = axisTable(fr(x * f), fr(f / np.spread[0]), sx, scratch(SX, sx));
      const ay = axisTable(fr(y * f), fr(f / np.spread[1]), sy, scratch(SY, sy));
      let idx = 0;
      for (let j = 0; j < sy; j += step) {
        const cy = ay.cell[j], v = ay.frac[j];
        for (let i = 0; i < sx; i += step, idx++) {
          const cx = ax.cell[i];
          let val = biLerp(noise2d(cx, cy, s), noise2d(cx + 1, cy, s),
            noise2d(cx, cy + 1, s), noise2d(cx + 1, cy + 1, s), ax.frac[i], v, eased);
          if (abs) val = Math.abs(val);
          if (gmap) {
            result[idx] = fr(result[idx] + fr(gmap[idx] * val));
            gmap[idx] = fr(gmap[idx] * persistMap[idx]);
          } else {
            result[idx] = fr(result[idx] + fr(g * val));
          }
        }
      }
      f = fr(f * np.lacunarity);
      g = fr(g * np.persist);
    }
    return finish(np, result);
  }

  // A lazily evaluated 3D noise map: same values as Noise::noiseMap3D over
  // (x..x+sx-1, y..y+sy-1, z..z+sz-1), but only computes the points asked for.
  function NoiseMap3D(np, worldSeed, x, y, z, sx, sy, sz) {
    this.np = np;
    this.eased = (np.flags & FLAG_EASED) !== 0;
    this.abs = (np.flags & FLAG_ABSVALUE) !== 0;
    this.scaled = Math.abs(np.offset - 0) > 0.00001 || Math.abs(np.scale - 1) > 0.00001;
    x = fr(x / np.spread[0]);
    y = fr(y / np.spread[1]);
    z = fr(z / np.spread[2]);
    this.oct = [];
    let f = fr(1), g = fr(1);
    for (let o = 0; o < np.octaves; o++) {
      this.oct.push({
        seed: (worldSeed + np.seed + o) | 0, g,
        ax: axisTableShared(fr(x * f), fr(f / np.spread[0]), sx),
        ay: axisTableShared(fr(y * f), fr(f / np.spread[1]), sy),
        az: axisTableShared(fr(z * f), fr(f / np.spread[2]), sz),
      });
      f = fr(f * np.lacunarity);
      g = fr(g * np.persist);
    }
  }
  NoiseMap3D.prototype.octaveValue = function (o, i, j, k) {
    const t = this.oct[o], s = t.seed;
    const cx = t.ax.cell[i], cy = t.ay.cell[j], cz = t.az.cell[k];
    let val = triLerp(
      noise3d(cx, cy, cz, s), noise3d(cx + 1, cy, cz, s),
      noise3d(cx, cy + 1, cz, s), noise3d(cx + 1, cy + 1, cz, s),
      noise3d(cx, cy, cz + 1, s), noise3d(cx + 1, cy, cz + 1, s),
      noise3d(cx, cy + 1, cz + 1, s), noise3d(cx + 1, cy + 1, cz + 1, s),
      t.ax.frac[i], t.ay.frac[j], t.az.frac[k], this.eased);
    return this.abs ? Math.abs(val) : val;
  };
  // Same result as octaveValue, for callers that walk down one column
  // (fixed i, k). colCache must be an array (one entry per octave) that
  // the caller keeps for that column only. Because the x and z steps
  // do not depend on y, the x-interpolated lattice edges can be reused for
  // every y in the same lattice cell; the float operations are performed in
  // exactly the same order as triLerp.
  NoiseMap3D.prototype.octaveValueCol = function (o, i, j, k, colCache) {
    if (this.eased || this.abs) return this.octaveValue(o, i, j, k);
    const t = this.oct[o];
    const cy = t.ay.cell[j];
    // colCache holds, per octave, the last lattice cell used: [cellY, e0..e3]
    let e = colCache[o];
    if (e === undefined) e = colCache[o] = new Float64Array(5).fill(NaN);
    if (e[0] !== cy) {
      const s = t.seed, cx = t.ax.cell[i], cz = t.az.cell[k], x = t.ax.frac[i];
      e[0] = cy;
      e[1] = lerp(noise3d(cx, cy, cz, s), noise3d(cx + 1, cy, cz, s), x);
      e[2] = lerp(noise3d(cx, cy + 1, cz, s), noise3d(cx + 1, cy + 1, cz, s), x);
      e[3] = lerp(noise3d(cx, cy, cz + 1, s), noise3d(cx + 1, cy, cz + 1, s), x);
      e[4] = lerp(noise3d(cx, cy + 1, cz + 1, s), noise3d(cx + 1, cy + 1, cz + 1, s), x);
    }
    const y = t.ay.frac[j];
    return lerp(lerp(e[1], e[2], y), lerp(e[3], e[4], y), t.az.frac[k]);
  };
  NoiseMap3D.prototype.getCol = function (i, j, k, colCache) {
    let r = 0;
    for (let o = 0; o < this.oct.length; o++)
      r = fr(r + fr(this.oct[o].g * this.octaveValueCol(o, i, j, k, colCache)));
    return this.scaled ? fr(fr(r * this.np.scale) + this.np.offset) : r;
  };

  // Exact value at sample (i, j, k).
  NoiseMap3D.prototype.get = function (i, j, k) {
    let r = 0;
    for (let o = 0; o < this.oct.length; o++)
      r = fr(r + fr(this.oct[o].g * this.octaveValue(o, i, j, k)));
    return this.scaled ? fr(fr(r * this.np.scale) + this.np.offset) : r;
  };

  // ---------------------------------------------------------------- points
  // Ports of NoiseFractal2D / NoiseFractal3D (single-point noise, used by
  // core.get_biome_data and by Lua mods through ValueNoise:get_2d/get_3d).
  // Note the engine's myfloor(): for a negative whole number it returns one
  // less than floor(), and that quirk is kept here.
  function myfloor(x) { return x < 0 ? Math.trunc(x) - 1 : Math.trunc(x); }

  function value2d(x, y, seed, eased) {
    const x0 = myfloor(x), y0 = myfloor(y);
    const xl = fr(x - x0), yl = fr(y - y0);
    return biLerp(noise2d(x0, y0, seed), noise2d(x0 + 1, y0, seed),
      noise2d(x0, y0 + 1, seed), noise2d(x0 + 1, y0 + 1, seed), xl, yl, eased);
  }
  function value3d(x, y, z, seed, eased) {
    const x0 = myfloor(x), y0 = myfloor(y), z0 = myfloor(z);
    const xl = fr(x - x0), yl = fr(y - y0), zl = fr(z - z0);
    return triLerp(
      noise3d(x0, y0, z0, seed), noise3d(x0 + 1, y0, z0, seed),
      noise3d(x0, y0 + 1, z0, seed), noise3d(x0 + 1, y0 + 1, z0, seed),
      noise3d(x0, y0, z0 + 1, seed), noise3d(x0 + 1, y0, z0 + 1, seed),
      noise3d(x0, y0 + 1, z0 + 1, seed), noise3d(x0 + 1, y0 + 1, z0 + 1, seed),
      xl, yl, zl, eased);
  }
  function noiseFractal2D(np, x, y, seed) {
    let a = 0, f = fr(1), g = fr(1);
    x = fr(fr(x) / np.spread[0]);
    y = fr(fr(y) / np.spread[1]);
    seed = (seed + np.seed) | 0;
    const eased = (np.flags & (FLAG_DEFAULTS | FLAG_EASED)) !== 0;
    for (let i = 0; i < np.octaves; i++) {
      let v = value2d(fr(x * f), fr(y * f), (seed + i) | 0, eased);
      if (np.flags & FLAG_ABSVALUE) v = Math.abs(v);
      a = fr(a + fr(g * v));
      f = fr(f * np.lacunarity);
      g = fr(g * np.persist);
    }
    return fr(np.offset + fr(a * np.scale));
  }
  function noiseFractal3D(np, x, y, z, seed) {
    let a = 0, f = fr(1), g = fr(1);
    x = fr(fr(x) / np.spread[0]);
    y = fr(fr(y) / np.spread[1]);
    z = fr(fr(z) / np.spread[2]);
    seed = (seed + np.seed) | 0;
    const eased = (np.flags & FLAG_EASED) !== 0;
    for (let i = 0; i < np.octaves; i++) {
      let v = value3d(fr(x * f), fr(y * f), fr(z * f), (seed + i) | 0, eased);
      if (np.flags & FLAG_ABSVALUE) v = Math.abs(v);
      a = fr(a + fr(g * v));
      f = fr(f * np.lacunarity);
      g = fr(g * np.persist);
    }
    return fr(np.offset + fr(a * np.scale));
  }

  const api = {
    noiseFractal2D, noiseFractal3D,
    readSeed, mapgenSeed, murmurHash64,
    noise2d, noise3d, value3d, NP, noiseMap2D, NoiseMap3D,
    FLAG_DEFAULTS, FLAG_EASED, FLAG_ABSVALUE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LuantiNoise = api;
})(typeof self !== 'undefined' ? self : this);
