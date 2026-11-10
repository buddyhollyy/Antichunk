// Ruined portal placement for Mineclonia v7 worlds, ported from Mineclonia
// (GPL-3.0):
//   mods/MAPGEN/mcl_levelgen/ruined_portal.lua  portal kinds and placement
//   mods/MAPGEN/mcl_levelgen/structures.lua     structure sets, random spread
//   mods/MAPGEN/mcl_levelgen/ersatz.lua         heights and biomes in v7 worlds
//   mods/MAPGEN/mcl_levelgen/biomes.lua         biome groups
//
// Mineclonia's structure code uses its own coordinates: 16-node chunks, a
// flipped Z axis (Luanti z = -z - 1) and Y raised by 64 (Luanti y = y - 64).
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const N = isNode ? require('./noise.js') : root.LuantiNoise;
  const BG = isNode ? require('./biomegen.js') : root.LuantiBiomes;
  const MV = isNode ? require('./villages.js') : root.MclVillages;
  const fr = Math.fround;
  const { JavaRandom, setRegionSeed, setCarverSeed, BIOME_TARGET } = MV;

  // Structure set "mcl_levelgen:ruined_portals": random spread, linear.
  const SPACING = 40, SEPARATION = 15, SALT = 34222645;

  // Level limits (ersatz overworld preset).
  const MIN_Y = -64, MAX_Y = MIN_Y + 384 - 1, FLOOR = MIN_Y + 15;
  const Y_OFFSET = 64; // level y = Luanti y + 64

  // Schematic sizes {x, y, z}, read from the .mts files.
  const SMALL = [[10, 12, 9], [10, 10, 5], [11, 6, 5], [8, 8, 6], [13, 10, 13]];
  const PORTALS = SMALL.concat(SMALL);          // the list repeats itself
  const GIANT = [[16, 16, 9], [15, 15, 10], [7, 12, 9]];

  // Biomes (Mineclonia level generator names) each portal kind accepts,
  // from the biome groups in biomes.lua.
  const B = (s) => new Set(s.split(' '));
  const KINDS = [ // in the order of the structure set
    { kind: 'standard', biomes: B('SnowyTaiga OldGrowthSpruceTaiga OldGrowthPineTaiga Taiga ' +
        'BirchForest OldGrowthBirchForest FlowerForest Forest Grove DarkForest ' +
        'Beach SnowyBeach River MushroomIslands IceSpikes DripstoneCaves LushCaves ' +
        'Savannah SnowyPlains Plains SunflowerPlains'),
      setups: [{ air: 1.0, placement: 'underground' }, { air: 0.5, placement: 'on_land_surface' }] },
    { kind: 'desert', biomes: B('Desert'), setups: [{ air: 0.0, placement: 'partly_buried' }] },
    { kind: 'jungle', biomes: B('BambooJungle Jungle SparseJungle'),
      setups: [{ air: 0.5, placement: 'on_land_surface' }] },
    { kind: 'swamp', biomes: B('Swamp MangroveSwamp'), setups: [{ air: 0.0, placement: 'on_ocean_floor' }] },
    { kind: 'mountain', biomes: B('Mesa ErodedMesa WoodedMesa WindsweptForest WindsweptGravellyHills ' +
        'WindsweptHills SavannahPlateau WindsweptSavannah StonyShore CherryGrove FrozenPeaks ' +
        'JaggedPeaks Meadow SnowySlopes StonyPeaks'),
      setups: [{ air: 1.0, placement: 'in_mountain' }, { air: 0.5, placement: 'on_land_surface' }] },
    { kind: 'ocean', biomes: B('Ocean DeepOcean ColdOcean DeepColdOcean FrozenOcean DeepFrozenOcean ' +
        'WarmOcean LukewarmOcean DeepLukewarmOcean'),
      setups: [{ air: 0.0, placement: 'on_ocean_floor' }] },
    { kind: 'nether', biomes: null, setups: null }, // never in the overworld
  ];
  const ID = {
    standard: 'mcl_levelgen:ruined_portal', desert: 'mcl_levelgen:ruined_portal_desert',
    jungle: 'mcl_levelgen:ruined_portal_jungle', swamp: 'mcl_levelgen:ruined_portal_swamp',
    mountain: 'mcl_levelgen:ruined_portal_mountain', ocean: 'mcl_levelgen:ruined_portal_ocean',
  };
  const OCEAN_OVERRIDES = {
    cold: { Ocean: 'ColdOcean', DeepOcean: 'DeepColdOcean' },
    snowy: { Ocean: 'FrozenOcean', DeepOcean: 'DeepFrozenOcean' },
    hot: { Ocean: 'WarmOcean', DeepOcean: 'LukewarmOcean' },
  };

  function Portals(world) {
    this.world = world;
    this.heights = new Map();
  }
  // ersatz_terrain:get_one_height(x, z, is_solid) in level coordinates.
  Portals.prototype.height = function (x, z, waterSolid) {
    const key = x + ',' + z + (waterSolid ? 'w' : '');
    let h = this.heights.get(key);
    if (h === undefined) {
      h = this.world.model.columnHeight(x, -z - 1, waterSolid) + Y_OFFSET;
      if (this.heights.size > 20000) this.heights.clear();
      this.heights.set(key, h);
    }
    return h;
  };
  // preset:index_biomes_block(x, y, z) in level coordinates.
  Portals.prototype.biome = function (x, y, z) {
    const w = this.world, lx = x, ly = y - Y_OFFSET, lz = -z - 1;
    const heat = fr(N.noiseFractal2D(BG.NP.heat, lx, lz, w.seed32) +
      N.noiseFractal2D(BG.NP.heat_blend, lx, lz, w.seed32));
    const hum = fr(N.noiseFractal2D(BG.NP.humidity, lx, lz, w.seed32) +
      N.noiseFractal2D(BG.NP.humidity_blend, lx, lz, w.seed32));
    const bi = BG.calcBiomeFromNoise(heat, hum, lx, ly, lz);
    const override = w.model.biomeOverride(lx, lz);
    if (override) {
      const t = OCEAN_OVERRIDES[BG.BIOMES[bi]._mcl_biome_type];
      return { name: (t && t[override]) || override, engine: bi };
    }
    return { name: BIOME_TARGET[bi], engine: bi };
  };

  // apply_vertical_placement (overworld placements only).
  Portals.prototype.vertical = function (rng, height, placement, bbox) {
    let baseY;
    if (placement === 'on_land_surface' || placement === 'on_ocean_floor') {
      baseY = height;
    } else {
      const tmp = height - (bbox[4] - bbox[1] + 1);
      if (placement === 'in_mountain') baseY = tmp <= 70 ? tmp : 70 + rng.nextWithin(tmp - 70 + 1);
      else if (placement === 'underground') baseY = tmp <= FLOOR ? tmp : FLOOR + rng.nextWithin(tmp - FLOOR + 1);
      else baseY = tmp + 2 + rng.nextWithin(7); // partly_buried
    }
    // get_one_column marks y as solid when y + 1 < height (water is air).
    const tops = [
      this.height(bbox[0], bbox[2], false), this.height(bbox[3], bbox[2], false),
      this.height(bbox[0], bbox[5], false), this.height(bbox[3], bbox[5], false),
    ].map((h) => h - 2).sort((a, b) => b - a);
    // Highest y at or below the start where three or more corners are solid.
    const y = Math.min(Math.min(baseY, MAX_Y), tops[2]);
    return y >= FLOOR + 1 ? y : FLOOR;
  };

  // ruined_portal_create_start for kind k at chunk (cx, cz).
  Portals.prototype.tryKind = function (k, cx, cz) {
    if (!k.biomes) return null;
    const rng = new JavaRandom();
    setCarverSeed(rng, this.world.levelSeed, cx, cz);
    let cfg = k.setups[0];
    if (k.setups.length > 1) {
      let weight = rng.nextFloat();
      for (const s of k.setups) {
        weight -= 1 / k.setups.length;
        if (weight < 0) { cfg = s; break; }
      }
    }
    if (cfg.air > 0 && cfg.air < 1) rng.nextFloat();
    let size, giant;
    if (rng.nextFloat() >= 0.05) { size = PORTALS[rng.nextWithin(PORTALS.length)]; giant = false; }
    else { size = GIANT[rng.nextWithin(GIANT.length)]; giant = true; }
    const rot = rng.nextWithin(4);
    rng.nextFloat();
    const sx = (rot & 1) ? size[2] : size[0], sy = size[1], sz = (rot & 1) ? size[0] : size[2];
    const x = cx * 16, z = cz * 16;
    const x1 = x - Math.floor(sx / 2), z1 = z - Math.floor(sz / 2);
    const bbox = [x1, 0, z1, x1 + sx - 1, sy - 1, z1 + sz - 1];
    const ccx = x1 + Math.floor(sx / 2), ccz = z1 + Math.floor(sz / 2);
    const height = this.height(ccx, ccz, cfg.placement !== 'on_ocean_floor');
    const by = this.vertical(rng, height, cfg.placement, bbox);
    const biome = this.biome(x, by, z);
    if (!k.biomes.has(biome.name)) return null;
    // /locate reports the center of the structure's bounding box.
    return {
      kind: k.kind, id: ID[k.kind], giant, placement: cfg.placement,
      x: ccx, y: by + Math.floor(sy / 2) - Y_OFFSET, z: -ccz - 1,
      cx, cz, biome: BG.BIOMES[biome.engine].name,
    };
  };

  // get_structure_starts for the ruined portal set in region (rx, rz).
  Portals.prototype.inRegion = function (rx, rz) {
    const w = this.world;
    const rng = new JavaRandom();
    setRegionSeed(rng, w.levelSeed, rx, rz, SALT);
    const cx = rx * SPACING + rng.nextWithin(SPACING - SEPARATION);
    const cz = rz * SPACING + rng.nextWithin(SPACING - SEPARATION);
    const gen = new JavaRandom();
    setCarverSeed(gen, w.levelSeed, cx, cz);
    const eliminated = new Set();
    let total = KINDS.length;
    while (eliminated.size < KINDS.length) {
      let weight = gen.nextWithin(total);
      let idx = 0;
      while (idx < KINDS.length) {
        if (!eliminated.has(idx)) { weight -= 1; if (weight < 0) break; }
        idx++;
      }
      const start = this.tryKind(KINDS[idx], cx, cz);
      if (start) return start;
      eliminated.add(idx);
      total -= 1;
    }
    return null;
  };

  function regionOf(lx, lz) {
    const cx = Math.floor(lx / 16), cz = Math.floor((-lz - 1) / 16);
    return [Math.floor(cx / SPACING), Math.floor(cz / SPACING)];
  }

  const api = { Portals, regionOf, SPACING, SEPARATION, SALT, KINDS, ID, PORTALS, GIANT };
  if (isNode) module.exports = api;
  else root.MclPortals = api;
})(typeof self !== 'undefined' ? self : this);
