// Colors for the biome view. Land biomes get their own color; the
// underwater parts (_ocean, _deep_ocean, ...) are drawn as water, tinted by
// the biome's temperature type; beaches and shores are drawn as sand.
(function (root) {
  'use strict';
  const LAND = {
    IcePlains: '#e8f0f2', IcePlainsSpikes: '#b4dcdc', ColdTaiga: '#3d6b5c',
    MegaTaiga: '#596651', MegaSpruceTaiga: '#6f7c66', ExtremeHills: '#7a7a7a',
    'ExtremeHills+': '#5d7a5d', 'ExtremeHills+_snowtop': '#dfe6ea', ExtremeHillsM: '#8aa08a',
    StoneBeach: '#a2a284', Plains: '#8db360', SunflowerPlains: '#b5db6e', Meadow: '#83bb6d',
    CherryGrove: '#f2b6d0', Grove: '#4f8f6e', SnowySlopes: '#c8d0d6', FrozenPeaks: '#a9b8f0',
    JaggedPeaks: '#e3e3d6', StonyPeaks: '#8e9488', Taiga: '#1f6b5c', Forest: '#2f7d32',
    FlowerForest: '#5aa05a', BirchForest: '#4f8f5a', BirchForestM: '#6aa878',
    Desert: '#f2b33d', RoofedForest: '#3f5420', PaleGarden: '#b9c2b4',
    Mesa: '#d9603b', MesaBryce: '#ef7e4f', MesaPlateauF: '#b09765', MesaPlateauFM: '#c9ad7b',
    MesaPlateauF_grasstop: '#9fa262', MesaPlateauFM_grasstop: '#a8ad6e',
    Savanna: '#bdb25f', SavannaM: '#d8cc82', Jungle: '#4e8a12', JungleM: '#6aa22c',
    BambooJungle: '#7f9a1c', JungleEdge: '#6b951f', JungleEdgeM: '#86ad3d',
    MangroveSwamp: '#5e6b2c', Swampland: '#4c7a55', MushroomIsland: '#c86fd6',
    Nether: '#8a3a32', SoulsandValley: '#5a4636', CrimsonForest: '#b02e2e', WarpedForest: '#167e86',
    BasaltDelta: '#55555c',
    LushCaves: '#3fae6a', DripstoneCave: '#8a7a68', DeepDark: '#1f2a33', default: '#555555',
  };
  const SAND = '#dccf98';
  const OCEAN = { snowy: '#7d8fd6', cold: '#3d5fb0', medium: '#2f5fc4', hot: '#2d7bd0' };

  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function dim(c, f) { return c.map((v) => Math.round(v * f)); }

  // Returns [r, g, b] for a biome {name, type}.
  function biomeColor(b) {
    const name = b.name;
    if (LAND[name]) return hex(LAND[name]);
    const m = name.match(/^(.*?)(_deep_ocean|_ocean|_beach_water|_beach|_shore|Shore|_sandlevel|_deep_underground|_underground)$/);
    if (!m) return hex(LAND.default);
    const base = m[1], suffix = m[2];
    if (suffix === '_ocean' || suffix === '_beach_water') return hex(OCEAN[b.type] || OCEAN.medium);
    if (suffix === '_deep_ocean') return dim(hex(OCEAN[b.type] || OCEAN.medium), 0.72);
    if (suffix === '_sandlevel') return hex('#d0a070');
    if (base === 'ColdTaiga' || base === 'IcePlains') return hex('#e4e4dc');
    if (suffix === '_beach' || suffix === '_shore' || suffix === 'Shore') return hex(SAND);
    return LAND[base] ? dim(hex(LAND[base]), 0.6) : hex(LAND.default);
  }

  const api = { biomeColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BiomeColors = api;
})(typeof self !== 'undefined' ? self : this);
