// Nether fortresses and bastion remnants for Mineclonia v7 worlds, ported
// from Mineclonia (GPL-3.0):
//   mods/MAPGEN/mcl_levelgen/fortress_bastion.lua  structure set and starts
//   mods/MAPGEN/mcl_levelgen/structures.lua        get_structure_starts,
//                                                   jigsaw_create_start
//   mods/MAPGEN/mcl_levelgen/templates.lua         generate_jigsaw
//   mods/MAPGEN/mcl_levelgen/ersatz.lua            Nether biomes in v7 worlds
//   mods/CORE/mcl_init/init.lua                    where the Nether layer is
//
// The Nether is a layer of the same Luanti world, 128 nodes tall from
// Luanti y -29067, with the same X and Z as the overworld.  Mineclonia's
// Nether level counts y from the bottom of that layer: Luanti y =
// level y - 29067; Luanti z = -z - 1 as elsewhere.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const N = isNode ? require('./noise.js') : root.LuantiNoise;
  const BG = isNode ? require('./biomegen.js') : root.LuantiBiomes;
  const MV = isNode ? require('./villages.js') : root.MclVillages;
  const fr = Math.fround;
  const { JavaRandom, setRegionSeed, setCarverSeed } = MV;

  const NETHER_MIN = -29067, NETHER_HEIGHT = 128;
  // ersatz.lua: Luanti biome name -> Mineclonia level generator name.
  const TARGET = { Nether: 'NetherWastes', SoulsandValley: 'SoulSandValley', CrimsonForest: 'CrimsonForest',
    WarpedForest: 'WarpedForest', BasaltDelta: 'BasaltDeltas' };
  const BASTION_BIOMES = new Set(['CrimsonForest', 'NetherWastes', 'SoulSandValley', 'WarpedForest']);
  const ROT = ['0', '90', '180', '270'];
  // bastion_treasure_start_aerated.dat, the only bastion start template.
  const BASTION_START = { w: 39, h: 70, l: 71 };

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

  // Nether biome of the Luanti column (lx, lz), as core.get_biome_data
  // reports it at Nether height.  Nether biomes have no vertical blend, so
  // the height inside the layer does not matter.  Returns the engine id.
  function biomeId(seed32, lx, lz) {
    const heat = fr(N.noiseFractal2D(BG.NP.heat, lx, lz, seed32) + N.noiseFractal2D(BG.NP.heat_blend, lx, lz, seed32));
    const hum = fr(N.noiseFractal2D(BG.NP.humidity, lx, lz, seed32) +
      N.noiseFractal2D(BG.NP.humidity_blend, lx, lz, seed32));
    return BG.calcBiomeFromNoise(heat, hum, lx, NETHER_MIN + 64, lz);
  }
  const biomeName = (id) => TARGET[BG.BIOMES[id].name] || 'NetherWastes';

  function Nether(world) { this.world = world; }
  // Biome at level coordinates (x, z).
  Nether.prototype.biome = function (x, z) { return biomeName(biomeId(this.world.seed32, x, -z - 1)); };

  // Structure set "mcl_levelgen:nether_complexes": random spread, spacing
  // 27, separation 4, salt 30084232, linear; fortress weight 2, bastion 3.
  const SPACING = 27, SEPARATION = 4, SALT = 30084232;
  const SET = [{ kind: 'fortress', weight: 2 }, { kind: 'bastion', weight: 3 }];

  Nether.prototype.fortress = function (cx, cz) {
    // Every Nether biome is in the "is_nether" group, so the biome test at
    // (cx * 16, 64, cz * 16) always passes and a fortress always starts.
    // Its first piece is laid out from (cx * 16 + 2, cz * 16 + 2); the rest
    // grows out up to 112 nodes from there, then the whole fortress is
    // moved to between level y 48 and 70.
    const x = cx * 16 + 2, z = cz * 16 + 2;
    return { kind: 'fortress', id: 'mcl_levelgen:nether_fortress', start: true,
      x, z: -z - 1, y: null, yMin: 48 + NETHER_MIN, yMax: 70 + NETHER_MIN, biome: this.biome(x, z),
      centerY() { return null; } };
  };
  Nether.prototype.bastion = function (cx, cz) {
    const rng = new JavaRandom();
    setCarverSeed(rng, this.world.levelSeed, cx, cz);
    const rot = ROT[rng.nextWithin(4)];          // random_schematic_rotation
    const b = templateBox(BASTION_START, cx * 16, 29, cz * 16, rot); // start_height 29
    const x = center(b, 0), z = center(b, 2);
    const biome = this.biome(x, z);
    if (!BASTION_BIOMES.has(biome)) return null;
    const y = center(b, 1) + NETHER_MIN;
    return { kind: 'bastion', id: 'mcl_levelgen:bastion_remnant', start: true,
      x, z: -z - 1, y, biome, centerY() { return y; } };
  };

  // get_structure_starts for the set in region (rx, rz).
  Nether.prototype.inRegion = function (rx, rz) {
    const w = this.world;
    const rng = new JavaRandom();
    setRegionSeed(rng, w.levelSeed, rx, rz, SALT);
    const cx = rx * SPACING + rng.nextWithin(SPACING - SEPARATION);
    const cz = rz * SPACING + rng.nextWithin(SPACING - SEPARATION);
    const gen = new JavaRandom();
    setCarverSeed(gen, w.levelSeed, cx, cz);
    const eliminated = new Set();
    let total = SET.reduce((a, s) => a + s.weight, 0);
    while (eliminated.size < SET.length) {
      let weight = gen.nextWithin(total);
      let idx = 0;
      while (idx < SET.length) {
        if (!eliminated.has(idx)) { weight -= SET[idx].weight; if (weight < 0) break; }
        idx++;
      }
      const start = this[SET[idx].kind](cx, cz);
      if (start) return start;
      eliminated.add(idx);
      total -= SET[idx].weight;
    }
    return null;
  };

  // ------------------------------------------------------------ ruined portals
  // The overworld's ruined portal set (portals.js) also runs in the Nether.
  // There every kind but "ruined_portal_nether" fails its biome test, and
  // that one passes everywhere (all Nether biomes are "is_nether"), so each
  // 40 x 40-chunk region has one.  In v7 worlds Mineclonia has no Nether
  // terrain model: every column counts as solid netherrack, so the portal
  // sits exactly at the height its random numbers pick.
  Nether.prototype.ruinedPortal = function (rx, rz) {
    const P = isNode ? require('./portals.js') : root.MclPortals;
    const w = this.world;
    const reg = new JavaRandom();
    setRegionSeed(reg, w.levelSeed, rx, rz, P.SALT);
    const cx = rx * P.SPACING + reg.nextWithin(P.SPACING - P.SEPARATION);
    const cz = rz * P.SPACING + reg.nextWithin(P.SPACING - P.SEPARATION);
    const rng = new JavaRandom();
    setCarverSeed(rng, w.levelSeed, cx, cz);
    const airPocket = rng.nextFloat() < 0.5;    // air_pocket_probability 0.5
    let size, giant;
    if (rng.nextFloat() >= 0.05) { size = P.PORTALS[rng.nextWithin(P.PORTALS.length)]; giant = false; }
    else { size = P.GIANT[rng.nextWithin(P.GIANT.length)]; giant = true; }
    const rot = rng.nextWithin(4);
    rng.nextFloat();
    const sx = (rot & 1) ? size[2] : size[0], sy = size[1], sz = (rot & 1) ? size[0] : size[2];
    const x1 = cx * 16 - Math.floor(sx / 2), z1 = cz * 16 - Math.floor(sz / 2);
    const x = x1 + Math.floor(sx / 2), z = z1 + Math.floor(sz / 2);
    let by;                                      // apply_vertical_placement, "in_nether"
    if (airPocket) by = 32 + rng.nextWithin(69);
    else if (rng.nextFloat() < 0.5) by = 27 + rng.nextWithin(3);
    else by = 29 + rng.nextWithin(72);
    const y = by + Math.floor(sy / 2) + NETHER_MIN;
    return { kind: 'nether_portal', id: 'mcl_levelgen:ruined_portal_nether', giant, x, y, z: -z - 1,
      biome: this.biome(x, z), centerY() { return y; } };
  };

  function portalRegionOf(lx, lz) {
    const sp = (isNode ? require('./portals.js') : root.MclPortals).SPACING;
    const cx = Math.floor(lx / 16), cz = Math.floor((-lz - 1) / 16);
    return [Math.floor(cx / sp), Math.floor(cz / sp)];
  }
  function regionOf(lx, lz) {
    const cx = Math.floor(lx / 16), cz = Math.floor((-lz - 1) / 16);
    return [Math.floor(cx / SPACING), Math.floor(cz / SPACING)];
  }

  const api = { Nether, regionOf, portalRegionOf, SPACING, NETHER_MIN, NETHER_HEIGHT, TARGET, biomeId };
  if (isNode) module.exports = api;
  else root.MclNether = api;
})(typeof self !== 'undefined' ? self : this);
