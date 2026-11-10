// Strongholds for Mineclonia v7 worlds, ported from Mineclonia (GPL-3.0):
//   mods/MAPGEN/mcl_levelgen/structures.lua  generate_stronghold_positions
//   mods/MAPGEN/mcl_levelgen/biomes.lua      locate_biome_in_area
//   mods/MAPGEN/mcl_levelgen/stronghold.lua  settings and preferred biomes
//
// 128 strongholds are spread over rings around the world center.  Each one
// is then moved to a random spot, within 112 nodes, whose biome (sampled
// every 4 nodes at level y 0, Luanti y -64) is on a preferred list.  That
// search is slow (3,249 biome samples), so it runs only for strongholds
// that are on screen.  The map marks the chunk the stronghold starts in;
// its rooms and corridors spread out from there and are not modeled.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const MV = isNode ? require('./villages.js') : root.MclVillages;
  const MP = isNode ? require('./portals.js') : root.MclPortals;
  const { JavaRandom } = MV;
  const COUNT = 128, DISTANCE = 32, SPREAD = 3, RADIUS = 112;

  const PREFERRED = new Set(('BambooJungle BirchForest Desert DripstoneCaves ErodedMesa FlowerForest ' +
    'Forest FrozenPeaks Grove IceSpikes JaggedPeaks Jungle LushCaves Meadow Mesa MushroomIslands ' +
    'OldGrowthBirchForest OldGrowthPineTaiga OldGrowthSpruceTaiga Plains Savannah SavannahPlateau ' +
    'SnowyPlains SnowySlopes SnowyTaiga SparseJungle StonyPeaks SunflowerPlains Taiga ' +
    'WindsweptForest WindsweptGravellyHills WindsweptHills WindsweptSavannah WoodedMesa').split(' '));

  function nextDouble(rng) {
    const hi = rng.next(26), lo = rng.next(27);
    return (hi * 134217728 + lo) / 0x1fffffffffffff;
  }
  function round(x) { // Mineclonia's round(): halves away from zero
    if (x < 0) { const i = Math.ceil(x); return i - ((x - i) <= -0.5 ? 1 : 0); }
    const i = Math.floor(x); return i + ((x - i) >= 0.5 ? 1 : 0);
  }

  function Strongholds(world) {
    this.world = world;
    this.p = new MP.Portals(world);
    // Ring positions and the seed of each one's biome search.
    const rng = new JavaRandom(world.levelSeed);
    let angle = nextDouble(rng) * Math.PI * 2;
    let completed = 0, triangle = 0, spread = SPREAD;
    this.rings = [];
    for (let i = 0; i < COUNT; i++) {
      const dist = (4 * DISTANCE + DISTANCE * triangle * 6) + (nextDouble(rng) - 0.5) * DISTANCE * 2.5;
      const cx = round(Math.cos(angle) * dist), cz = round(Math.sin(angle) * dist);
      const searchSeed = rng.nextLong(); // fork_into
      this.rings.push({ i, ring: triangle, cx, cz, searchSeed, result: undefined });
      angle += (Math.PI * 2) / spread;
      completed++;
      if (completed === spread) {
        triangle++;
        completed = 0;
        spread = spread + (2 * spread / (triangle + 1));
        spread = Math.min(spread, COUNT - i);
        angle += nextDouble(rng) * Math.PI * 2;
      }
    }
  }

  // The finished stronghold for ring entry s (worked out once).
  Strongholds.prototype.resolve = function (s) {
    if (s.result !== undefined) return s.result;
    const rng = new JavaRandom(s.searchSeed);
    const qx = (s.cx * 16 + 8) >> 2, qz = (s.cz * 16 + 8) >> 2, qr = RADIUS >> 2;
    let found = null, matches = 0;
    for (let dz = -qr; dz <= qr; dz++) {
      for (let dx = -qr; dx <= qr; dx++) {
        const bx = (qx + dx) * 4, bz = (qz + dz) * 4;
        if (!PREFERRED.has(this.p.biome(bx, 0, bz).name)) continue;
        if (!found || rng.nextWithin(matches + 1) === 0) found = [bx, bz];
        matches++;
      }
    }
    const cx = found ? found[0] >> 4 : s.cx, cz = found ? found[1] >> 4 : s.cz;
    // stronghold_create_start: the biome at the chunk corner, level y 0,
    // must be in the "is_overworld" group (Cold Ocean is not).
    if (this.p.biome(cx * 16, 0, cz * 16).name === 'ColdOcean') { s.result = null; return null; }
    s.result = { kind: 'stronghold', id: 'mcl_levelgen:stronghold', start: true, ring: s.ring + 1,
      x: cx * 16 + 8, z: -(cz * 16 + 8) - 1, y: null, centerY() { return null; } };
    return s.result;
  };

  // Ring entries whose search area could reach the given Luanti box.
  Strongholds.prototype.near = function (x0, z0, x1, z1) {
    const pad = RADIUS + 16;
    return this.rings.filter((s) => {
      const x = s.cx * 16 + 8, z = -(s.cz * 16 + 8) - 1;
      return x >= x0 - pad && x <= x1 + pad && z >= z0 - pad && z <= z1 + pad;
    });
  };

  const api = { Strongholds };
  if (isNode) module.exports = api;
  else root.MclStrongholds = api;
})(typeof self !== 'undefined' ? self : this);
