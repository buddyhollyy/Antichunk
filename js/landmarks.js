// Pillager outposts, trail ruins and trial chambers for Mineclonia v7
// worlds, ported from Mineclonia (GPL-3.0):
//   mods/MAPGEN/mcl_levelgen/pillager_outpost.lua, trail_ruins.lua,
//   trial_chambers.lua      each structure's start
//   mods/MAPGEN/mcl_levelgen/structures.lua, templates.lua
//
// Level coordinates as in portals.js: Luanti z = -z - 1, Luanti y = y - 64.
// Outposts are placed exactly (center of the whole outpost, as /locate
// reports).  Trail ruins and trial chambers are built piece by piece from
// a starting room; the map marks the center of that starting room, which
// can be some way from the center /locate reports for the finished
// structure (as with villages).
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const MV = isNode ? require('./villages.js') : root.MclVillages;
  const MP = isNode ? require('./portals.js') : root.MclPortals;
  const { JavaRandom, setRegionSeed, setCarverSeed } = MV;
  const Y_OFFSET = 64;
  const ROT = ['0', '90', '180', '270'];
  const M64 = (1n << 64n) - 1n;

  function transform(x, y, z, rot) {
    if (rot === '270') return [z, y, -x];
    if (rot === '90') return [-z, y, x];
    if (rot === '180') return [-x, y, -z];
    return [x, y, z];
  }
  function templateBox(t, x, y, z, rot) {
    const a = transform(0, 0, 0, rot), b = transform(t.w - 1, t.h - 1, t.l - 1, rot);
    return [Math.min(a[0], b[0]) + x, Math.min(a[1], b[1]) + y, Math.min(a[2], b[2]) + z,
      Math.max(a[0], b[0]) + x, Math.max(a[1], b[1]) + y, Math.max(a[2], b[2]) + z];
  }
  const center = (b, i) => b[i] + Math.floor((b[i + 3] - b[i] + 1) / 2);
  const overlaps = (a, b) => a[0] <= b[3] && a[1] <= b[4] && a[2] <= b[5] && a[3] >= b[0] && a[4] >= b[1] && a[5] >= b[2];

  function region(levelSeed, rx, rz, spacing, separation, salt, triangular) {
    const rng = new JavaRandom();
    setRegionSeed(rng, levelSeed, rx, rz, salt);
    const n = spacing - separation;
    const d = triangular ? () => Math.trunc((rng.nextWithin(n) + rng.nextWithin(n)) / 2) : () => rng.nextWithin(n);
    const cx = rx * spacing + d();
    const cz = rz * spacing + d();
    return [cx, cz];
  }

  function Landmarks(world) {
    this.world = world;
    this.p = new MP.Portals(world);
  }
  Landmarks.prototype.h = function (x, z, waterSolid) { return this.p.height(x, z, waterSolid); };
  Landmarks.prototype.biome = function (x, y, z) { return this.p.biome(x, y, z).name; };

  // ------------------------------------------------------------ outposts
  // Schematic sizes [x, y, z] from the .mts files.
  const S = {
    tower_short: [13, 17, 14], tower_tall: [13, 40, 14], tent: [6, 5, 4],
    cage_1: [7, 5, 7], cage_2: [6, 5, 6], scarecrow: [3, 3, 1],
  };
  const FEATURES = ['tent', 'cage_2', 'cage_1'];
  const OFFSETS = [[-12, 12], [12, 12], [16, -12]];
  const OUTPOST_BIOMES = new Set(['Desert', 'Plains', 'Savannah', 'SnowyPlains', 'Taiga', 'Grove',
    'CherryGrove', 'FrozenPeaks', 'JaggedPeaks', 'Meadow', 'SnowySlopes', 'StonyPeaks']);

  // make_schematic_piece with centring.
  function schematicPiece(name, x, y, z, rot) {
    let [sx, sy, sz] = S[name];
    if (rot === '90' || rot === '270') [sx, sz] = [sz, sx];
    x -= Math.trunc((sx - 1) / 2);
    z -= Math.trunc((sz - 1) / 2);
    return { name, rot, bbox: [x, y, z, x + sx - 1, y + sy - 1, z + sz - 1] };
  }

  // frequency_reducer_type_1 (1 in 5).
  function outpostRoll(levelSeed, cx, cz) {
    const hash = (cx >> 4) ^ (cz & ~15);
    const rng = new JavaRandom();
    rng.reseed((BigInt.asUintN(64, BigInt(hash)) ^ levelSeed) & M64);
    rng.next(32);
    return rng.nextWithin(5) === 0;
  }

  // No outpost within 10 chunks of a village candidate chunk (whether or
  // not a village is actually built there).
  Landmarks.prototype.nearVillageCandidate = function (cx, cz) {
    const sp = 34;
    for (let rx = Math.floor((cx - 10) / sp); rx <= Math.floor((cx + 10) / sp); rx++) {
      for (let rz = Math.floor((cz - 10) / sp); rz <= Math.floor((cz + 10) / sp); rz++) {
        const [vx, vz] = MV.regionCandidate(this.world.levelSeed, rx, rz);
        if (Math.abs(vx - cx) <= 10 && Math.abs(vz - cz) <= 10) return true;
      }
    }
    return false;
  };

  Landmarks.prototype.outpost = function (rx, rz) {
    const w = this.world;
    const [cx, cz] = region(w.levelSeed, rx, rz, 32, 8, 165745296);
    if (!outpostRoll(w.levelSeed, cx, cz)) return null;
    if (this.nearVillageCandidate(cx, cz)) return null;
    const x = cx * 16, z = cz * 16;
    const height = this.h(x, z, false);
    const biome = this.biome(x, height, z);
    if (!OUTPOST_BIOMES.has(biome)) return null;
    const rng = new JavaRandom();
    setCarverSeed(rng, w.levelSeed, cx, cz);
    // select_tower_piece
    const tx = x + rng.nextWithin(32) - 16, tz = z + rng.nextWithin(32) - 16;
    const ty = this.h(tx, tz, false);
    const tall = rng.next(1) === 0;
    const tower = schematicPiece(tall ? 'tower_tall' : 'tower_short', tx, ty, tz, ROT[rng.nextWithin(4)]);
    const pieces = [tower];
    const n = 8 + rng.nextWithin(3);
    const heights = [];
    for (let i = 0; i < n; i++) {
      const idx = rng.nextWithin(3);
      let [ox, oz] = OFFSETS[idx];
      if (tower.rot === '90') [ox, oz] = [oz, -ox];
      else if (tower.rot === '180') [ox, oz] = [-ox, -oz];
      else if (tower.rot === '270') [ox, oz] = [-oz, ox];
      const b = tower.bbox;
      const fx = ox < 0 ? b[0] + ox : b[3] + ox, fz = oz < 0 ? b[2] + oz : b[5] + oz;
      if (heights[idx] !== undefined) {
        const dx = rng.nextWithin(4) - 6, dz = rng.nextWithin(4) - 6;
        const p = schematicPiece('scarecrow', fx + dx, heights[idx], fz + dz, tower.rot);
        if (!pieces.some((q) => overlaps(q.bbox, p.bbox))) pieces.push(p);
      } else {
        const fh = this.h(fx, fz, false);
        heights[idx] = fh;
        const sel = rng.nextWithin(3);
        pieces.push(schematicPiece(FEATURES[sel], fx, fh, fz, ROT[rng.nextWithin(4)]));
      }
    }
    const all = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const add = (b) => { for (let i = 0; i < 3; i++) { all[i] = Math.min(all[i], b[i]); all[i + 3] = Math.max(all[i + 3], b[i + 3]); } };
    for (const p of pieces) add(p.bbox);
    const ccx = center(all, 0), ccz = center(all, 2);
    add([ccx - 35, height - 12, ccz - 35, ccx + 36, height + 39, ccz + 36]); // spawn area
    const r = { kind: 'outpost', id: 'mcl_levelgen:pillager_outpost', tall, biome,
      x: center(all, 0), y: center(all, 1) - Y_OFFSET, z: -center(all, 2) - 1 };
    r.centerY = () => r.y;
    return r;
  };

  // ------------------------------------------------------------ jigsaw starts
  const TRAIL_BIOMES = new Set(['Jungle', 'OldGrowthBirchForest', 'OldGrowthPineTaiga',
    'OldGrowthSpruceTaiga', 'SnowyTaiga', 'Taiga']);
  // Biomes in the "is_overworld" group, as v7 worlds report them (the only
  // one left out is ColdOcean, which Mineclonia does not mark overworld).
  const NOT_OVERWORLD = new Set(['ColdOcean']);

  Landmarks.prototype.trailRuins = function (rx, rz) {
    const w = this.world;
    const [cx, cz] = region(w.levelSeed, rx, rz, 34, 8, 83469867);
    const rng = new JavaRandom();
    setCarverSeed(rng, w.levelSeed, cx, cz);
    const rot = ROT[rng.nextWithin(4)];
    const b = templateBox({ w: 9, h: 12, l: 9 }, cx * 16, -15, cz * 16, rot);
    const x = center(b, 0), z = center(b, 2);
    const sy = -15 + this.h(x, z, true); // projected to the surface
    const biome = this.biome(x, sy, z);
    if (!TRAIL_BIOMES.has(biome)) return null;
    const r = { kind: 'trail_ruins', id: 'mcl_levelgen:trail_ruins', start: true,
      x, y: sy + 6 - Y_OFFSET, z: -z - 1 };
    r.centerY = () => r.y;
    return r;
  };

  Landmarks.prototype.trialChambers = function (rx, rz) {
    const w = this.world;
    const [cx, cz] = region(w.levelSeed, rx, rz, 34, 12, 94251327);
    const rng = new JavaRandom();
    setCarverSeed(rng, w.levelSeed, cx, cz);
    const sy = rng.nextWithin(21) - 40;
    const rot = ROT[rng.nextWithin(4)];
    const b = templateBox({ w: 19, h: 19, l: 19 }, cx * 16, sy, cz * 16, rot);
    const x = center(b, 0), z = center(b, 2);
    if (NOT_OVERWORLD.has(this.biome(x, sy, z))) return null;
    const r = { kind: 'trial_chambers', id: 'mcl_levelgen:trial_chambers', start: true,
      x, y: sy + 9 - Y_OFFSET, z: -z - 1 };
    r.centerY = () => r.y;
    return r;
  };

  // ------------------------------------------------------------ mansions
  // woodland_mansion.lua: the ground at the start point and four nearby
  // points must be at level y 60 or above, and the biome Dark Forest.  The
  // mansion's layout comes from a different random generator and is not
  // modeled; the map marks the start point the layout is built around.
  const MANSION_DIR = { '0': [5, 5], '90': [-5, 5], '180': [-5, -5], '270': [5, -5] };
  Landmarks.prototype.mansion = function (rx, rz) {
    const w = this.world;
    const [cx, cz] = region(w.levelSeed, rx, rz, 80, 20, 10387319, true);
    const rng = new JavaRandom();
    setCarverSeed(rng, w.levelSeed, cx, cz);
    const rot = ROT[rng.nextWithin(4)];
    const [dx, dz] = MANSION_DIR[rot];
    const x = cx * 16 + 7, z = cz * 16 + 7;
    const lowest = Math.min(this.h(x, z, true), this.h(x, z + dz, true), this.h(x + dx, z, true),
      this.h(x + dx, z + dz, true)) - 1;
    if (lowest < 60) return null;
    if (this.biome(x, lowest, z) !== 'DarkForest') return null;
    const r = { kind: 'mansion', id: 'mcl_levelgen:woodland_mansion', start: true,
      x, y: lowest - Y_OFFSET, z: -z - 1 };
    r.centerY = () => r.y;
    return r;
  };

  // ------------------------------------------------------------ per-chunk structures
  // Buried treasure and mineshafts can start in any chunk, so they are
  // worked out for a block of 16 x 16 chunks at a time.
  const BLOCK = 16;

  // buried_treasure.lua: 1 in 100 chunks (frequency_reducer_type_2), then
  // in v7 worlds a "beach" test: ground 2 to 4 nodes above sea level, with
  // the ground 10 nodes away diagonally dipping below sea level.
  Landmarks.prototype.treasureBlock = function (bx, bz) {
    const w = this.world, out = [];
    const rng = new JavaRandom();
    for (let cx = bx * BLOCK; cx < (bx + 1) * BLOCK; cx++) {
      for (let cz = bz * BLOCK; cz < (bz + 1) * BLOCK; cz++) {
        setRegionSeed(rng, w.levelSeed, cx, cz, 10387320);
        if (!(rng.nextFloat() < 0.01)) continue;
        const x = cx * 16 + 8, z = cz * 16 + 8;
        const y = this.h(x, z, false);
        if (!(y - 65 > 1 && y - 65 <= 4)) continue;
        const low = Math.min(this.h(x + 10, z + 10, false), this.h(x - 10, z - 10, false),
          this.h(x + 10, z - 10, false), this.h(x - 10, z + 10, false));
        if (!(low < 65)) continue;
        if (NOT_OVERWORLD.has(this.biome(x, y, z))) continue;
        out.push({ kind: 'treasure', id: 'mcl_levelgen:buried_treasure',
          x: x + 1, y: y - Y_OFFSET, z: -(z + 1) - 1, centerY() { return this.y; } });
      }
    }
    return out;
  };

  // mineshaft.lua: 4 in 1000 chunks (frequency_reducer_type_3).  The only
  // biome that refuses one is Deep Dark, which in v7 worlds sits at the
  // very bottom of the world, so that test is left out.  The tunnels are
  // not modeled; the map marks the chunk the mineshaft starts in.
  Landmarks.prototype.mineshaftBlock = function (bx, bz) {
    const w = this.world, out = [];
    const rng = new JavaRandom();
    for (let cx = bx * BLOCK; cx < (bx + 1) * BLOCK; cx++) {
      for (let cz = bz * BLOCK; cz < (bz + 1) * BLOCK; cz++) {
        setCarverSeed(rng, w.levelSeed, cx, cz);
        if (!(rng.nextFloat() < 0.004)) continue;
        const mesa = this.biome(cx * 16 + 8, 50, cz * 16 + 8);
        out.push({ kind: 'mineshaft', id: 'mcl_levelgen:mineshaft', start: true,
          mesa: /Mesa$/.test(mesa), x: cx * 16 + 8, y: null, z: -(cz * 16 + 8) - 1, centerY() { return null; } });
      }
    }
    return out;
  };

  const LAYERS = {
    treasure: { spacing: BLOCK, fn: 'treasureBlock' },
    mineshaft: { spacing: BLOCK, fn: 'mineshaftBlock' },
    mansion: { spacing: 80, fn: 'mansion' },
    outpost: { spacing: 32, fn: 'outpost' },
    trail_ruins: { spacing: 34, fn: 'trailRuins' },
    trial_chambers: { spacing: 34, fn: 'trialChambers' },
  };
  function regionOf(spacing, lx, lz) {
    const cx = Math.floor(lx / 16), cz = Math.floor((-lz - 1) / 16);
    return [Math.floor(cx / spacing), Math.floor(cz / spacing)];
  }

  const api = { Landmarks, LAYERS, regionOf };
  if (isNode) module.exports = api;
  else root.MclLandmarks = api;
})(typeof self !== 'undefined' ? self : this);
