// Shipwrecks, ocean ruins and ocean monuments for Mineclonia v7 worlds,
// ported from Mineclonia (GPL-3.0):
//   mods/MAPGEN/mcl_levelgen/shipwreck.lua, ocean_ruins.lua,
//   ocean_monument.lua      each structure's start
//   mods/MAPGEN/mcl_levelgen/structures.lua, templates.lua, util.lua
//
// Level coordinates as in portals.js: Luanti z = -z - 1, Luanti y = y - 64.
// Positions are the center of the structure's bounding box, as /locate
// reports.  In v7 worlds these structures only appear where Mineclonia's
// own terrain model says the ground is under the ocean.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const MV = isNode ? require('./villages.js') : root.MclVillages;
  const MP = isNode ? require('./portals.js') : root.MclPortals;
  const { JavaRandom, setRegionSeed, setCarverSeed } = MV;
  const Y_OFFSET = 64, SEA_LEVEL = 65;

  // Template sizes {w, h, l} and, for ocean ruins, how many sand (warm) or
  // gravel (cold) nodes each holds: a random shuffle of those nodes uses
  // up random numbers before the next piece is chosen.
  const tp = (w, h, l, n) => ({ w, h, l, n });
  const SHIPWRECKS = [tp(25, 19, 12), tp(29, 19, 12), tp(28, 19, 12), tp(19, 19, 12), tp(16, 19, 9)];
  const RUINS = {
    cold: {
      big: [tp(14, 6, 12, 113), tp(12, 8, 11, 105), tp(14, 12, 17, 183)],
      small: [tp(7, 8, 7, 35), tp(5, 6, 5, 25), tp(6, 4, 6, 29), tp(8, 7, 9, 65), tp(8, 8, 9, 66), tp(8, 8, 9, 66)],
    },
    warm: {
      big: [tp(14, 7, 16, 134), tp(15, 6, 15, 169), tp(16, 5, 16, 186)],
      small: [tp(6, 5, 8, 40), tp(5, 5, 8, 32), tp(4, 4, 4, 14)],
    },
  };
  const ROT = ['0', '90', '180', '270'];

  function transform(x, y, z, px, pz, rot) {
    if (rot === '270') return [px - pz + z, y, px + pz - x];
    if (rot === '90') return [px + pz - z, y, pz - px + x];
    if (rot === '180') return [px + px - x, y, pz + pz - z];
    return [x, y, z];
  }
  function templateBox(t, x, y, z, px, pz, rot) {
    const a = transform(0, 0, 0, px, pz, rot);
    const b = transform(t.w - 1, t.h - 1, t.l - 1, px, pz, rot);
    return [Math.min(a[0], b[0]) + x, Math.min(a[1], b[1]) + y, Math.min(a[2], b[2]) + z,
      Math.max(a[0], b[0]) + x, Math.max(a[1], b[1]) + y, Math.max(a[2], b[2]) + z];
  }
  const center = (b, i) => b[i] + Math.floor((b[i + 3] - b[i] + 1) / 2);

  function Ocean(world) {
    this.world = world;
    this.p = new MP.Portals(world);
  }
  Ocean.prototype.h = function (x, z) { return this.p.height(x, z, false); };
  Ocean.prototype.biome = function (x, y, z) { return this.p.biome(x, y, z).name; };
  Ocean.prototype.isOceanColumn = function (x, z) { return !!this.world.model.biomeOverride(x, -z - 1); };

  function region(levelSeed, rx, rz, spacing, separation, salt, triangular) {
    const rng = new JavaRandom();
    setRegionSeed(rng, levelSeed, rx, rz, salt);
    const n = spacing - separation;
    const d = triangular ? () => Math.trunc((rng.nextWithin(n) + rng.nextWithin(n)) / 2) : () => rng.nextWithin(n);
    const cx = rx * spacing + d();
    const cz = rz * spacing + d();
    return [cx, cz];
  }

  // ------------------------------------------------------------ shipwrecks
  // Set: shipwreck and shipwreck_beached; beached ones need a beach biome,
  // which v7 worlds never report, so only ocean shipwrecks appear.
  Ocean.prototype.shipwreck = function (rx, rz) {
    const w = this.world;
    const [cx, cz] = region(w.levelSeed, rx, rz, 24, 4, 165745295, false);
    const x = cx * 16 + 8, z = cz * 16 + 8;
    if (!this.isOceanColumn(x, z)) return null;
    const rng = new JavaRandom();
    setCarverSeed(rng, w.levelSeed, cx, cz);
    const rot = ROT[rng.nextWithin(4)];
    const t = SHIPWRECKS[rng.nextWithin(SHIPWRECKS.length)];
    const b = templateBox(t, x - 8, 90, z - 8, 0, 5, rot);
    const r = { kind: 'shipwreck', id: 'mcl_levelgen:shipwreck', x: center(b, 0), z: -center(b, 2) - 1, y: null };
    r.centerY = () => {
      if (r.y === null) {
        let sum = 0, n = 0;
        for (let xx = b[0]; xx <= b[3]; xx++) for (let zz = b[2]; zz <= b[5]; zz++) { sum += this.h(xx, zz); n++; }
        r.y = Math.trunc(sum / n) - 1 + Math.floor(t.h / 2) - Y_OFFSET;
      }
      return r.y;
    };
    return r;
  };

  // ------------------------------------------------------------ ocean ruins
  const COLD = new Set(['FrozenOcean', 'ColdOcean', 'Ocean', 'DeepFrozenOcean', 'DeepColdOcean', 'DeepOcean']);
  const WARM = new Set(['LukewarmOcean', 'WarmOcean', 'DeepLukewarmOcean']);

  function onePiece(rng, temp, large, rot, x, z) {
    const list = RUINS[temp][large ? 'big' : 'small'];
    const t = list[rng.nextWithin(list.length)];
    const b = templateBox(t, x, 90, z, 0, 0, rot);
    for (let i = t.n; i >= 2; i--) rng.nextWithin(i); // fisher_yates
    return { t, b, large };
  }

  Ocean.prototype.oceanRuin = function (rx, rz) {
    const w = this.world;
    const [cx, cz] = region(w.levelSeed, rx, rz, 20, 8, 14357621, false);
    const x = cx * 16 + 8, z = cz * 16 + 8;
    const biome = this.biome(x, this.h(x, z), z);
    const temp = COLD.has(biome) ? 'cold' : WARM.has(biome) ? 'warm' : null;
    if (!temp) return null;
    const rng = new JavaRandom();
    setCarverSeed(rng, w.levelSeed, cx, cz);
    const x0 = x - 8, z0 = z - 8;
    const rot = ROT[rng.nextWithin(4)];
    const large = rng.nextFloat() <= 0.3;
    const pieces = [onePiece(rng, temp, large, rot, x0, z0)];
    let cluster = false;
    if (large && rng.nextFloat() <= 0.9) {
      cluster = true;
      const c = transform(15, 0, 15, 0, 0, rot);
      const ccx = Math.min(c[0] + x0, x0), ccz = Math.min(c[2] + z0, z0);
      const parent = [ccx, 0, ccz, ccx + x0, 1, ccz + z0];
      const nw = (n) => rng.nextWithin(n);
      const p = [];
      p.push(nw(7) + 1 - 16 + ccx, nw(7) + 1 - 16 + ccz);
      p.push(nw(7) + 1 - 16 + ccx, nw(7) + 1 + ccz);
      p.push(nw(7) + 1 - 16 + ccx, nw(4) + 4 - 16 + ccz);
      p.push(nw(7) + 1 + ccx, nw(7) + 1 + 16 + ccz);
      p.push(nw(7) + 1 + ccx, nw(2) + 4 - 16 + ccz);
      p.push(nw(7) + 1 + ccx + 16, nw(5) + 3 + 16 + ccz);
      p.push(nw(7) + 1 + ccx + 16, nw(7) + 1 + ccz);
      p.push(nw(7) + 1 + ccx + 16, nw(4) + 4 + ccz - 16);
      for (let i = p.length / 2 - 1; i >= 1; i--) { // fisher_yates_pairs
        const j = rng.nextWithin(i + 1);
        [p[2 * i], p[2 * j]] = [p[2 * j], p[2 * i]];
        [p[2 * i + 1], p[2 * j + 1]] = [p[2 * j + 1], p[2 * i + 1]];
      }
      const max = 4 + rng.nextWithin(4);
      for (let i = 0; i <= max * 2; i += 2) {
        const px = p[i], pz = p[i + 1];
        const r2 = ROT[rng.nextWithin(4)];
        const o = transform(5, 0, 6, 0, 0, r2);
        // Mineclonia's overlap test, as written (it compares with min z twice).
        const ax1 = Math.min(o[0], px), az1 = Math.min(o[2], pz), ax2 = Math.max(o[0], px), az2 = Math.min(o[2], pz);
        const overlaps = parent[3] >= ax1 && parent[0] <= ax2 && parent[5] >= az1 && parent[2] <= az2;
        if (!overlaps) pieces.push(onePiece(rng, temp, false, r2, px, pz));
      }
    }
    // Each piece sits on the sea floor under its own center.
    const all = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const pc of pieces) {
      const b = pc.b, height = b[4] - b[1] + 1;
      const y = this.h(center(b, 0), center(b, 2)) - 1;
      const nb = [b[0], y, b[2], b[3], y + height - 1, b[5]];
      for (let i = 0; i < 3; i++) { all[i] = Math.min(all[i], nb[i]); all[i + 3] = Math.max(all[i + 3], nb[i + 3]); }
    }
    const r = { kind: 'ocean_ruin', id: 'mcl_levelgen:ocean_ruin_' + temp, temp, large, cluster,
      count: pieces.length, x: center(all, 0), y: center(all, 1) - Y_OFFSET, z: -center(all, 2) - 1 };
    r.centerY = () => r.y;
    return r;
  };

  // ------------------------------------------------------------ monuments
  const DEEP = new Set(['DeepOcean', 'DeepColdOcean', 'DeepFrozenOcean', 'DeepLukewarmOcean']);
  Ocean.prototype.monument = function (rx, rz) {
    const w = this.world;
    const [cx, cz] = region(w.levelSeed, rx, rz, 32, 5, 10387313, true);
    const x = cx * 16 + 9, z = cz * 16 + 9;
    // The center must be a deep ocean (checked first here because it is
    // quicker; Mineclonia checks the surroundings first, same result).
    const x1 = x - 1, z1 = z - 1;
    if (!DEEP.has(this.biome(x1, this.h(x1, z1) - 1, z1))) return null;
    // Every biome sample (4-node grid) within 29 nodes must be ocean.
    for (let qx = (x - 29) >> 2; qx <= (x + 29) >> 2; qx++) {
      for (let qz = (z - 29) >> 2; qz <= (z + 29) >> 2; qz++) {
        if (!this.isOceanColumn(qx * 4, qz * 4)) return null;
      }
    }
    // The monument is 58 x 23 x 58 nodes from level y 39, centered on the
    // chunk corner.
    const r = { kind: 'monument', id: 'mcl_levelgen:ocean_monument',
      x: cx * 16, y: 39 + 11 - Y_OFFSET, z: -(cz * 16) - 1 };
    r.centerY = () => r.y;
    return r;
  };

  const LAYERS = {
    shipwreck: { spacing: 24, fn: 'shipwreck' },
    ocean_ruin: { spacing: 20, fn: 'oceanRuin' },
    monument: { spacing: 32, fn: 'monument' },
  };
  function regionOf(spacing, lx, lz) {
    const cx = Math.floor(lx / 16), cz = Math.floor((-lz - 1) / 16);
    return [Math.floor(cx / spacing), Math.floor(cz / spacing)];
  }

  const api = { Ocean, LAYERS, regionOf };
  if (isNode) module.exports = api;
  else root.MclOcean = api;
})(typeof self !== 'undefined' ? self : this);
