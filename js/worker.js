// Web worker: computes one map tile (one 80x80 mapchunk) and colors it.
// Expects LuantiNoise and LuantiV7 to be loaded in the same worker first.
(function () {
  'use strict';
  const V7 = self.LuantiV7;

  // Height color stops: [y, r, g, b]
  const LAND = [
    [1, 214, 200, 142],   // beach
    [4, 120, 172, 82],
    [30, 86, 148, 62],
    [70, 70, 120, 52],
    [110, 128, 112, 84],
    [150, 138, 134, 128],
    [190, 236, 238, 242], // snowy peaks
  ];
  const WATER = [
    [0, 74, 140, 206],
    [-8, 46, 102, 176],
    [-30, 24, 62, 130],
    [-80, 12, 32, 84],
  ];

  function ramp(stops, y, descending) {
    if (descending ? y >= stops[0][0] : y <= stops[0][0]) return stops[0];
    for (let s = 1; s < stops.length; s++) {
      const a = stops[s - 1], b = stops[s];
      if (descending ? y >= b[0] : y <= b[0]) {
        const t = (y - a[0]) / (b[0] - a[0]);
        return [0, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
      }
    }
    return stops[stops.length - 1];
  }

  const BG = self.LuantiBiomes;
  const BC = self.BiomeColors;
  const BIOME_RGB = BG.BIOMES.map((b) => BC.biomeColor(b));
  const OCEAN_RGB = { snowy: [125, 143, 214], cold: [61, 95, 176], medium: [47, 95, 196], hot: [45, 123, 208] };

  // Nether tiles: only the biome, which in the Nether depends on X and Z
  // alone (Mineclonia's Nether biomes fill the whole layer, no blending).
  const NETHER_Y = -29067 + 64;
  function netherTile(seed, cx, cz, step) {
    const biome = BG.chunkBiomes(seed, cx, cz, step, null, NETHER_Y);
    const m = Math.ceil(80 / step);
    const surface = new Int16Array(m * m); // no height model in the Nether
    const rgba = new Uint8ClampedArray(m * m * 4);
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const c = BIOME_RGB[biome[kk * m + ii]];
      const o = ((m - 1 - kk) * m + ii) * 4;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
    }
    return { m, rgba, rgbaB: rgba, surface, water: new Uint8Array(m * m), biome };
  }

  // End tiles: end stone islands over the void, shaded by height.
  let endState = null;
  function endTile(seed64text, cx, cz, step) {
    const E = self.MclEnd;
    const seed64 = BigInt(seed64text);
    if (!endState || endState.seed !== seed64text) {
      endState = { seed: seed64text, strata: E.strata(seed64), island: null };
    }
    const m = Math.ceil(80 / step);
    const surface = E.strataTops(seed64, cx, cz, step, endState.strata);
    if (cx <= 200 && cx + 79 >= -200 && cz <= 200 && cz + 79 >= -200) {
      if (!endState.island) endState.island = new E.Island(seed64);
      for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
        const t = endState.island.top(cx + ii * step, cz + kk * step);
        if (t !== null && t > surface[kk * m + ii]) surface[kk * m + ii] = t;
      }
    }
    const rgba = new Uint8ClampedArray(m * m * 4);
    const biome = new Uint8Array(m * m);
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const idx = kk * m + ii, y = surface[idx];
      const o = ((m - 1 - kk) * m + ii) * 4;
      let c;
      if (y === -32768) c = [16, 14, 26];
      else {
        const t = Math.max(0, Math.min(1, (y - (E.END_MIN + 46)) / 34)); // low = darker
        c = [150 + 80 * t, 150 + 82 * t, 100 + 58 * t];
      }
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
      biome[idx] = { island: 0, border: 1, outer: 2 }[E.area(cx + ii * step, cz + kk * step)];
    }
    return { m, rgba, rgbaB: rgba, surface, water: new Uint8Array(m * m), biome };
  }

  function overworldTile(seed, cx, cz, step) {
    const r = V7.generateChunkTop(seed, cx, cz, step);
    const m = r.size, H = r.surface;
    const biome = BG.chunkBiomes(seed, cx, cz, step, H);
    const rgba = new Uint8ClampedArray(m * m * 4);   // terrain view
    const rgbaB = new Uint8ClampedArray(m * m * 4);  // biome view
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      const idx = kk * m + ii;
      const y = H[idx];
      const wet = r.water[idx];
      const c = wet ? ramp(WATER, y, true) : ramp(LAND, y, false);
      // Simple hill shading: light from the north-west.
      let shade = 1;
      if (!wet) {
        const w = H[kk * m + Math.max(ii - 1, 0)];
        const n = H[Math.min(kk + 1, m - 1) * m + ii];
        const slope = ((w - y) + (n - y)) / step;
        shade = Math.max(0.6, Math.min(1.35, 1 + slope * 0.06));
      }
      // Image rows go top-down, so +Z (north) is drawn at the top.
      const o = ((m - 1 - kk) * m + ii) * 4;
      rgba[o] = c[1] * shade; rgba[o + 1] = c[2] * shade; rgba[o + 2] = c[3] * shade; rgba[o + 3] = 255;

      let bc, bshade = shade;
      if (wet) {
        bc = OCEAN_RGB[BG.BIOMES[biome[idx]].type] || OCEAN_RGB.medium;
        bshade = Math.max(0.55, 1 + y / 60); // deeper water is darker
      } else {
        bc = BIOME_RGB[biome[idx]];
        bshade = 0.85 + (shade - 1) * 0.6 + 0.15;
      }
      rgbaB[o] = bc[0] * bshade; rgbaB[o + 1] = bc[1] * bshade; rgbaB[o + 2] = bc[2] * bshade; rgbaB[o + 3] = 255;
    }
    return { m, rgba, rgbaB, surface: H, water: r.water, biome };
  }

  // One map tile: g x g mapchunks starting at (cx, cz), each sampled every
  // step-th node, stitched into one image so that zoomed-out views need far
  // fewer tiles (and far fewer canvases and draw calls on the page).
  // Structure icons: a batch of region jobs for the seed's finders.
  let finders = null;
  function iconBatch(d) {
    const IJ = self.MclIconJobs;
    if (!finders || finders.seed !== d.seedText) { finders = new IJ.Finders(d.seedText); finders.seed = d.seedText; }
    const out = d.icons.map(([id, job]) => [id, IJ.plain(finders.run(job))]);
    self.postMessage({ icons: out, gen: d.gen });
  }

  self.onmessage = function (e) {
    if (e.data.icons) { iconBatch(e.data); return; }
    const { id, seed, cx, cz, step } = e.data;
    const g = e.data.g || 1;
    const one = (x, z) => (e.data.nether ? netherTile(seed, x, z, step)
      : e.data.end ? endTile(e.data.seed64, x, z, step) : overworldTile(seed, x, z, step));
    let out;
    if (g === 1) out = one(cx, cz);
    else {
      const m = Math.ceil(80 / step), M = m * g;
      out = { m: M, rgba: new Uint8ClampedArray(M * M * 4), rgbaB: new Uint8ClampedArray(M * M * 4),
        surface: new Int16Array(M * M), water: new Uint8Array(M * M), biome: new Uint8Array(M * M) };
      for (let gz = 0; gz < g; gz++) for (let gx = 0; gx < g; gx++) {
        const t = one(cx + gx * 80, cz + gz * 80);
        for (let kk = 0; kk < m; kk++) {
          const src = kk * m, dst = (gz * m + kk) * M + gx * m;
          out.surface.set(t.surface.subarray(src, src + m), dst);
          out.water.set(t.water.subarray(src, src + m), dst);
          out.biome.set(t.biome.subarray(src, src + m), dst);
          // Image rows run top-down (north first).
          const isrc = (m - 1 - kk) * m * 4, idst = ((M - 1 - (gz * m + kk)) * M + gx * m) * 4;
          out.rgba.set(t.rgba.subarray(isrc, isrc + m * 4), idst);
          out.rgbaB.set(t.rgbaB.subarray(isrc, isrc + m * 4), idst);
        }
      }
    }
    const rgbaB = out.rgbaB === out.rgba ? null : out.rgbaB;
    const transfer = [out.rgba.buffer, out.surface.buffer, out.water.buffer, out.biome.buffer];
    if (rgbaB) transfer.push(rgbaB.buffer);
    self.postMessage({ id, size: out.m, rgba: out.rgba, rgbaB, surface: out.surface, water: out.water, biome: out.biome },
      transfer);
  };
})();
