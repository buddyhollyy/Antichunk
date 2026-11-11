// Village placement for Mineclonia v7 worlds, ported from Mineclonia
// (GPL-3.0):
//   mods/MAPGEN/mcl_levelgen/random.lua      Java-style random numbers
//   mods/MAPGEN/mcl_levelgen/structures.lua  random spread placement
//   mods/MAPGEN/mcl_villages/lg_register.lua village structures
//   mods/MAPGEN/mcl_levelgen/ersatz.lua      biome lookup in v7 worlds
//   mods/MAPGEN/mcl_mapgen_models/v7.lua     Mineclonia's v7 height model
//
// Mineclonia's structure code uses Minecraft-style coordinates: 16-node
// chunks, and a Z axis that is flipped (Luanti z = -z - 1).
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const N = isNode ? require('./noise.js') : root.LuantiNoise;
  const BG = isNode ? require('./biomegen.js') : root.LuantiBiomes;
  const V7 = isNode ? require('./v7.js') : root.LuantiV7;
  const fr = Math.fround;

  // ------------------------------------------------------------ Java random
  const M64 = (1n << 64n) - 1n;
  const MULT = 0x5deece66dn, MASK48 = (1n << 48n) - 1n;
  const s64 = (v) => BigInt.asIntN(64, v);

  function JavaRandom(seed) { this.reseed(seed || 0n); }
  JavaRandom.prototype.reseed = function (seed) { this.seed = (BigInt(seed) ^ MULT) & MASK48; };
  // Returns the top `bits` bits of the next state (unsigned).
  JavaRandom.prototype.next = function (bits) {
    this.seed = (this.seed * MULT + 11n) & MASK48;
    return Number(this.seed >> BigInt(48 - bits));
  };
  JavaRandom.prototype.nextLong = function () {
    const hi = BigInt(this.next(32)), lo = BigInt(this.next(32));
    return ((hi << 32n) + BigInt.asIntN(32, lo)) & M64;
  };
  // Same as Mineclonia's next_within (note its retry test uses >= 0x7fffffff).
  JavaRandom.prototype.nextWithin = function (y) {
    if ((y & (y - 1)) === 0) {
      return Number((BigInt(this.next(31)) * BigInt(y)) >> 31n);
    }
    let n = this.next(31), m = n % y;
    while (n - m + (y - 1) >= 0x7fffffff) { n = this.next(31); m = n % y; }
    return m;
  };
  JavaRandom.prototype.nextFloat = function () { return this.next(24) * (1 / 0xffffff); };

  function setRegionSeed(rng, levelSeed, rx, rz, salt) {
    rng.reseed((BigInt(rx) * 341873128712n + BigInt(rz) * 132897987541n + levelSeed + BigInt(salt)) & M64);
  }
  function setCarverSeed(rng, levelSeed, cx, cz) {
    rng.reseed(levelSeed);
    const a = rng.nextLong(), b = rng.nextLong();
    rng.reseed(((BigInt(cx) * a) ^ (BigInt(cz) * b) ^ levelSeed) & M64);
  }

  // ------------------------------------------------------------ height model
  // mcl_mapgen_models/v7.lua: Lua (double precision) arithmetic on noise
  // values from ValueNoise:get_2d/get_3d (single-point engine noise).
  const NP = V7.NP;
  const SEA = 1, ZERO = 0, OVERWORLD_MIN = -128;
  function valueNoiseMax(np) { // note: starts at 1.0, as in Mineclonia
    let a = 1.0, g = 1.0;
    for (let i = 0; i < np.octaves; i++) { a += g; g *= np.persist; }
    return np.offset + a * np.scale;
  }
  const MOUNTAIN_MAX = valueNoiseMax(NP.mountain);
  const RIDGE_MIN = -valueNoiseMax(NP.ridge);
  const rtz = Math.trunc;

  // Mountain test, as in columnHeight below: n3(mountain) + grad >= 0.
  // Octaves are added one at a time, exactly as noiseFractal3D does, and
  // the work stops once the answer is certain.  Each octave is a linear
  // interpolation between lattice values in [-1, 1], so it changes by at
  // most 2 * f / spread per node in y; when even the best case is well
  // below the threshold, the next nodes down cannot be solid either and
  // the scan may jump past them.  Returns 1 (solid), 0 (not solid) or
  // d > 0 (not solid for this node and the d - 1 nodes below it).
  const MNP = NP.mountain, M_REST = [], M_SLOPE = [];
  { const gs = []; let g = 1, f = 1, sl = 0;
    for (let o = 0; o < MNP.octaves; o++) {
      gs.push(g); sl += g * 2 * f / MNP.spread[1]; M_SLOPE.push(sl * Math.abs(MNP.scale));
      g *= MNP.persist; f *= MNP.lacunarity;
    }
    for (let o = 0; o < gs.length; o++) M_REST.push(gs.slice(o + 1).reduce((a, b) => a + b, 0) * 1.0001); }
  function mountainTest(seed, x, y, z, mounthn) {
    const grad = -((y - ZERO) / mounthn);
    let a = 0, f = fr(1), g = fr(1), skip = 0;
    const px = fr(fr(x) / MNP.spread[0]), py = fr(fr(y) / MNP.spread[1]), pz = fr(fr(z) / MNP.spread[2]);
    const s = (seed + MNP.seed) | 0;
    for (let o = 0; o < MNP.octaves; o++) {
      a = fr(a + fr(g * N.value3d(fr(px * f), fr(py * f), fr(pz * f), (s + o) | 0, false)));
      f = fr(f * MNP.lacunarity);
      g = fr(g * MNP.persist);
      if (o === MNP.octaves - 1) break;
      const best = MNP.offset + MNP.scale * (a + M_REST[o]) + grad;
      if (best < -1e-3) {
        const d = Math.floor((-best - 0.005) / (M_SLOPE[o] + 1 / mounthn));
        return d > 1 ? d : 0;
      }
      if (MNP.offset + MNP.scale * (a - M_REST[o]) + grad > 1e-3) return 1;
    }
    const v = fr(MNP.offset + fr(a * MNP.scale)) + grad;
    if (v >= 0.0) return 1;
    const d = Math.floor((-v - 0.005) / (M_SLOPE[MNP.octaves - 1] + 1 / mounthn));
    return d > 1 ? d : 0;
  }

  function Model(seed32) { this.seed = seed32; }
  Model.prototype.n2 = function (np, x, z) { return N.noiseFractal2D(np, x, z, this.seed); };
  Model.prototype.n3 = function (np, x, y, z) { return N.noiseFractal3D(np, x, y, z, this.seed); };
  Model.prototype.baseTerrainLevel = function (x, z) {
    const persistence = this.n2(NP.terrain_persist, x, z);
    const pb = Object.assign({}, NP.terrain_base, { persist: fr(persistence) });
    const pa = Object.assign({}, NP.terrain_alt, { persist: fr(persistence) });
    let hselect = this.n2(NP.height_select, x, z);
    const alt = this.n2(pa, x, z), base = this.n2(pb, x, z);
    hselect = Math.max(0.0, Math.min(hselect, 1.0));
    const h = alt > base ? alt : base * hselect + alt * (1.0 - hselect);
    return rtz(h);
  };
  const MOUNT_SAMPLES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
  // Returns 'DeepOcean', 'Ocean' or null.  (x, z) in Luanti coordinates.
  Model.prototype.biomeOverride = function (x, z) {
    let base = this.baseTerrainLevel(x, z);
    if (base < SEA - 2) {
      const mounthn = Math.max(1.0, this.n2(NP.mount_height, x, z));
      let mountn = 0.0;
      for (const y of MOUNT_SAMPLES) mountn = Math.max(mountn, this.n3(NP.mountain, x, y, z));
      base = base + Math.max(mountn * mounthn, 0.0) + ZERO;
      if (base < SEA - 15) return 'DeepOcean';
      if (base < SEA - 2) return 'Ocean';
    }
    return null;
  };
  // get_column_height(x, z, liquids_solid): first non-solid y above the
  // column as Mineclonia's model sees it.
  Model.prototype.columnHeight = function (x, z, liquidsSolid) {
    const base = this.baseTerrainLevel(x, z);
    let anyRiver = false, riverMax = -Infinity, absuw = 0, widthMod = 0;
    absuw = Math.abs(this.n2(NP.ridge_uwater, x, z)) * 2.0;
    anyRiver = absuw <= 0.2;
    if (anyRiver) {
      widthMod = 0.2 - absuw;
      const maxAlt = (-119 * widthMod + 10.5) / (2.5 * RIDGE_MIN + 7 * widthMod);
      riverMax = Math.ceil(SEA + maxAlt);
    }
    const mounthn = Math.max(1.0, this.n2(NP.mount_height, x, z));
    const mountmax = Math.ceil(mounthn / MOUNTAIN_MAX) + Math.ceil(ZERO + mounthn);
    const self = this;
    const mountains = (y) => y <= base ||
      self.n3(NP.mountain, x, y, z) + -((y - ZERO) / mounthn) >= 0.0;
    const notRiver = (y) => {
      const altitude = y - SEA;
      const heightMod = (altitude + 17.0) / 2.5;
      const nridge = self.n3(NP.ridge, x, y, z) * Math.max(0, altitude) / 7.0;
      return nridge + widthMod * heightMod < 0.6;
    };
    // mountains are on, so mountmax is finite: the sampler is
    // "mountains" or "mountains and not river".
    const sampler = anyRiver ? (y) => notRiver(y) && mountains(y) : mountains;
    const yStart = Math.max(base, mountmax, riverMax);
    if (liquidsSolid && yStart <= SEA) return SEA + 1;
    // Same scan as Mineclonia's, but above the base level the mountain
    // test may skip nodes it has shown cannot be solid.
    const floor = liquidsSolid ? Math.max(base, SEA) : base;
    for (let y = yStart; y >= OVERWORLD_MIN; y--) {
      if (liquidsSolid && y <= SEA) return y + 1;
      if (y > base) {
        const m = mountainTest(this.seed, x, y, z, mounthn);
        if (m !== 1) {
          if (m > 1) y = Math.max(y - m + 1, floor) + 1;
          continue;
        }
        if (!anyRiver || notRiver(y)) return y + 1;
        continue;
      }
      if (sampler(y)) return y + 1;
    }
    return OVERWORLD_MIN;
  };

  // ------------------------------------------------------------ biome names
  // ersatz.lua: engine biome -> Mineclonia level generator biome.
  const ERSATZ = {
    BambooJungle: 'BambooJungle', BirchForest: 'BirchForest', BirchForestM: 'OldGrowthBirchForest',
    ColdTaiga: 'SnowyTaiga', DeepDark: 'DeepDark', Desert: 'Desert', DripstoneCave: 'DripstoneCaves',
    ExtremeHills: 'WindsweptHills', 'ExtremeHills+': 'WindsweptHills', ExtremeHillsM: 'WindsweptGravellyHills',
    FlowerForest: 'FlowerForest', Forest: 'Forest', FrozenPeaks: 'FrozenPeaks', Grove: 'Grove',
    IcePlains: 'SnowyPlains', IcePlainsSpikes: 'IceSpikes', JaggedPeaks: 'JaggedPeaks', Jungle: 'Jungle',
    JungleEdge: 'SparseJungle', JungleEdgeM: 'SparseJungle', JungleM: 'Jungle', LushCaves: 'LushCaves',
    MangroveSwamp: 'MangroveSwamp', Meadow: 'Meadow', MegaSpruceTaiga: 'OldGrowthSpruceTaiga',
    MegaTaiga: 'OldGrowthPineTaiga', Mesa: 'Mesa', MesaBryce: 'ErodedMesa', MesaPlateauF: 'WoodedMesa',
    MesaPlateauFM: 'WoodedMesa', MushroomIsland: 'MushroomIslands', Plains: 'Plains', RoofedForest: 'DarkForest',
    Savanna: 'Savannah', SavannaM: 'Savannah', SnowySlopes: 'SnowySlopes', StoneBeach: 'StonyShore',
    StonyPeaks: 'StonyPeaks', SunflowerPlains: 'SunflowerPlains', Swampland: 'Swamp', Taiga: 'Taiga',
  };
  const SUBTYPES = ['_shore', '_beach', '_ocean', '_deep_ocean', '_sandlevel', '_snowtop',
    '_beach_water', '_underground', '_deep_underground'];
  const TRANSLATE = {};
  for (const [b, t] of Object.entries(ERSATZ)) {
    TRANSLATE[b] = t;
    for (const s of SUBTYPES) TRANSLATE[b + s] = t;
  }
  // Index the engine biome list (BG.BIOMES) once.
  const BIOME_TARGET = BG.BIOMES.map((b) => TRANSLATE[b.name] || 'Plains');

  // ------------------------------------------------------------ villages
  const VILLAGE_TYPES = [ // in the order of the structure set
    { type: 'plains', biomes: ['Plains', 'Meadow'], roll: 204, zombieAt: 200 },
    { type: 'desert', biomes: ['Desert'], roll: 250, zombieAt: 245 },
    { type: 'savannah', biomes: ['Savannah'], roll: 459, zombieAt: 450 },
    { type: 'snowy', biomes: ['SnowyPlains'], roll: 306, zombieAt: 300 },
    { type: 'taiga', biomes: ['Taiga'], roll: 100, zombieAt: 98 },
  ];
  const SPACING = 34, SEPARATION = 8, SALT = 10387312;

  // Candidate chunk (Mineclonia chunk coordinates) for a placement region.
  function regionCandidate(levelSeed, rx, rz) {
    const rng = new JavaRandom();
    setRegionSeed(rng, levelSeed, rx, rz, SALT);
    const cx = rx * SPACING + rng.nextWithin(SPACING - SEPARATION);
    const cz = rz * SPACING + rng.nextWithin(SPACING - SEPARATION);
    return [cx, cz];
  }

  // Works out whether a village starts in placement region (rx, rz).
  // Returns null, or { type, zombie, x, z, cx, cz, biome } with x, z the
  // village center in Luanti coordinates.
  function villageInRegion(world, rx, rz) {
    const [cx, cz] = regionCandidate(world.levelSeed, rx, rz);
    const x = cx * 16, zl = cz * 16;           // Mineclonia coordinates
    const lx = x, lz = -zl - 1;               // Luanti coordinates
    // get_one_height(x, z, is_not_air): water counts as solid.
    const h = world.model.columnHeight(lx, lz, true);
    // index_biomes_block(x, h + 64, z): engine biome at Luanti (x, h, -z-1)
    if (world.model.biomeOverride(lx, lz)) return null; // ocean
    const heat = fr(N.noiseFractal2D(BG.NP.heat, lx, lz, world.seed32) +
      N.noiseFractal2D(BG.NP.heat_blend, lx, lz, world.seed32));
    const hum = fr(N.noiseFractal2D(BG.NP.humidity, lx, lz, world.seed32) +
      N.noiseFractal2D(BG.NP.humidity_blend, lx, lz, world.seed32));
    const bi = BG.calcBiomeFromNoise(heat, hum, lx, h, lz);
    const target = BIOME_TARGET[bi];
    const vt = VILLAGE_TYPES.find((t) => t.biomes.includes(target));
    if (!vt) return null;
    // assemble_village: rotation, zombie roll, then the start offset.
    const rng = new JavaRandom();
    setCarverSeed(rng, world.levelSeed, cx, cz);
    rng.nextWithin(4);
    const zombie = rng.nextWithin(vt.roll) >= vt.zombieAt;
    const dx = rng.nextWithin(16) - 8, dz = rng.nextWithin(16) - 8;
    return { type: vt.type, zombie, x: x + dx, z: -(zl + dz) - 1, cx, cz,
      biome: BG.BIOMES[bi].name, height: h };
  }

  // mapgen: 'v7' (default), a Flat spec such as 'flat:lakes,hills' or a
  // Valleys spec such as 'valleys' or 'valleys:altitude_chill', or
  // 'carpathian' / 'carpathian:rivers', or 'v5'.
  // Only Mineclonia's height model differs between map generators.
  function World(seedText, mapgen) {
    this.levelSeed = N.readSeed(seedText);
    this.seed32 = N.mapgenSeed(this.levelSeed);
    this.mapgen = mapgen || 'v7';
    const F = isNode ? require('./flat.js') : root.LuantiFlat;
    const VL = isNode ? require('./valleys.js') : root.LuantiValleys;
    const CP = isNode ? require('./carpathian.js') : root.LuantiCarpathian;
    this.model = this.mapgen.startsWith('flat') ? new F.Model(this.seed32, F.parseFlags(this.mapgen))
      : this.mapgen.startsWith('valleys') ? new VL.Model(this.seed32, VL.parseFlags(this.mapgen))
      : this.mapgen.startsWith('carpathian') ? new CP.Model(this.seed32, CP.parseFlags(this.mapgen))
      : this.mapgen === 'v5' ? new (isNode ? require('./v5.js') : root.LuantiV5).Model(this.seed32)
      : new Model(this.seed32);
  }

  // Region containing a Luanti block position.
  function regionOf(lx, lz) {
    const cx = Math.floor(lx / 16), cz = Math.floor((-lz - 1) / 16);
    return [Math.floor(cx / SPACING), Math.floor(cz / SPACING)];
  }

  const api = { JavaRandom, setRegionSeed, setCarverSeed, Model, World, regionCandidate,
    villageInRegion, regionOf, SPACING, BIOME_TARGET };
  if (isNode) module.exports = api;
  else root.MclVillages = api;
})(typeof self !== 'undefined' ? self : this);
