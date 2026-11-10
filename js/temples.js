// Desert pyramids, jungle temples, igloos and swamp huts for Mineclonia v7
// worlds, ported from Mineclonia (GPL-3.0):
//   mods/MAPGEN/mcl_levelgen/desert_pyramid.lua, jungle_temple.lua,
//   igloo.lua, swamp_hut.lua    each structure's start
//   mods/MAPGEN/mcl_levelgen/structures.lua, templates.lua   shared helpers
//
// Level coordinates as in portals.js: Luanti z = -z - 1, Luanti y = y - 64.
// Positions are the center of the structure's bounding box, which is what
// Mineclonia's /locate reports.  The Y of desert pyramids, jungle temples
// and swamp huts needs the height of every column under them, which is
// slow, so it is worked out only when asked for (centerY()).
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const MV = isNode ? require('./villages.js') : root.MclVillages;
  const MP = isNode ? require('./portals.js') : root.MclPortals;
  const { JavaRandom, setRegionSeed, setCarverSeed } = MV;

  const SEA_LEVEL = 65, Y_OFFSET = 64;
  const ROT = ['0', '90', '180', '270'];
  const DIRS = ['north', 'east', 'south', 'west'];

  // Template sizes {width, height, length} from the .dat templates.
  const T = {
    jungle: { w: 12, h: 15, l: 15 },
    iglooTop: { w: 7, h: 6, l: 8 }, iglooMiddle: { w: 3, h: 4, l: 3 }, iglooBottom: { w: 7, h: 7, l: 9 },
  };

  // Java nextDouble as Mineclonia writes it.
  function nextDouble(rng) {
    const hi = rng.next(26), lo = rng.next(27);
    return (hi * 134217728 + lo) / 0x1fffffffffffff;
  }

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
  function rotatedBox(x, y, z, dir, w, h, l) {
    return (dir === 'north' || dir === 'south')
      ? [x, y, z, x + w - 1, y + h - 1, z + l - 1]
      : [x, y, z, x + l - 1, y + h - 1, z + w - 1];
  }
  function union(boxes) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of boxes) {
      for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], p[i]); b[i + 3] = Math.max(b[i + 3], p[i + 3]); }
    }
    return b;
  }
  const center = (b, i) => b[i] + Math.floor((b[i + 3] - b[i] + 1) / 2);

  function Temples(world) {
    this.world = world;
    this.p = new MP.Portals(world); // shares the height cache and biome lookup
  }
  Temples.prototype.h = function (x, z) { return this.p.height(x, z, true); };
  Temples.prototype.biome = function (x, y, z) { return this.p.biome(x, y, z).name; };
  // lowest_corner_from_point
  Temples.prototype.lowestCorner = function (x1, z1, dx, dz) {
    return Math.min(this.h(x1, z1), this.h(x1, z1 + dz), this.h(x1 + dx, z1), this.h(x1 + dx, z1 + dz)) - 1;
  };
  Temples.prototype.areaHeights = function (b) {
    const out = [];
    for (let x = b[0]; x <= b[3]; x++) for (let z = b[2]; z <= b[5]; z++) out.push(this.h(x, z));
    return out;
  };

  function result(kind, id, b, cx, cz, biome, yFn) {
    const r = { kind, id, x: center(b, 0), z: -center(b, 2) - 1, cx, cz, biome, y: null };
    if (yFn) r.centerY = () => (r.y === null ? (r.y = yFn() - Y_OFFSET) : r.y);
    else { r.y = center(b, 1) - Y_OFFSET; r.centerY = () => r.y; }
    return r;
  }

  const STARTS = {
    desert_pyramid(t, rng, cx, cz) {
      if (t.lowestCorner(cx * 16, cz * 16, 21, 21) < SEA_LEVEL) return null;
      const x = cx * 16 + 8, z = cz * 16 + 8, y = t.h(x, z);
      if (t.biome(x, y, z) !== 'Desert') return null;
      const dir = DIRS[rng.nextWithin(4)];
      const b = rotatedBox(x - 8, y, z - 8, dir, 21, 15, 21);
      const sink = -rng.nextWithin(3);
      return result('desert_pyramid', 'mcl_levelgen:desert_pyramid', b, cx, cz, 'Desert',
        () => Math.min(...t.areaHeights(b)) + sink + 7);
    },
    jungle_temple(t, rng, cx, cz) {
      const J = T.jungle;
      if (t.lowestCorner(cx * 16, cz * 16, J.w, J.l) < SEA_LEVEL) return null;
      const x0 = cx * 16 + 8, z0 = cz * 16 + 8, y = t.h(x0, z0);
      const biome = t.biome(x0, y, z0);
      if (biome !== 'BambooJungle' && biome !== 'Jungle') return null;
      const rot = ROT[rng.nextWithin(4)];
      let x = x0 - 8, z = z0 - 8;
      if (rot === '90') x += J.l - 1;
      else if (rot === '180') { x += J.w + 1; z += J.l - 1; }
      else if (rot === '270') z += J.w - 1;
      const b = templateBox(J, x, y, z, 0, 0, rot);
      return result('jungle_temple', 'mcl_levelgen:jungle_temple', b, cx, cz, biome, () => {
        const hs = t.areaHeights(b);
        const avg = Math.trunc(hs.reduce((a, v) => a + v, 0) / hs.length);
        return avg - 4 + Math.floor(J.h / 2);
      });
    },
    igloo(t, rng, cx, cz) {
      const x = cx * 16 + 8, z = cz * 16 + 8;
      const y = t.h(x, z);
      const rot = ROT[rng.nextWithin(4)];
      const basement = nextDouble(rng) < 0.5;
      const biome = t.biome(x, y, z);
      if (biome !== 'SnowyTaiga' && biome !== 'SnowyPlains' && biome !== 'SnowySlopes') return null;
      const y2 = t.h(x - 8, z - 8);
      const boxes = [templateBox(T.iglooTop, x - 8, y2 - 1, z - 8, 3, 6, rot)];
      if (basement) {
        const segments = rng.nextWithin(8) + 4;
        const labY = y2 - 1 - segments * T.iglooMiddle.h - T.iglooBottom.h;
        boxes.push(templateBox(T.iglooBottom, x - 8, labY, z - 8 - 1, 3, 7, rot));
        const baseY = labY + T.iglooBottom.h;
        for (let i = 0; i < segments; i++) {
          boxes.push(templateBox(T.iglooMiddle, x - 8 + 2, baseY + i * T.iglooMiddle.h, z - 8 + 5, 1, 1, rot));
        }
      }
      const r = result('igloo', 'mcl_levelgen:igloo', union(boxes), cx, cz, biome, null);
      r.basement = basement;
      return r;
    },
    swamp_hut(t, rng, cx, cz) {
      const x = cx * 16 + 8, z = cz * 16 + 8, y = t.h(x, z);
      if (t.biome(x, y, z) !== 'Swamp') return null;
      const dir = DIRS[rng.nextWithin(4)];
      const b = rotatedBox(x - 8, y, z - 8, dir, 7, 7, 9);
      return result('swamp_hut', 'mcl_levelgen:swamp_hut', b, cx, cz, 'Swamp', () => {
        const hs = t.areaHeights(b);
        return Math.trunc(hs.reduce((a, v) => a + v, 0) / hs.length) + 3;
      });
    },
  };

  // Each structure has its own set: random spread, 32 x 32 chunks,
  // separation 8, linear.
  const SETS = {
    desert_pyramid: 14357617, igloo: 14357618, jungle_temple: 14357619, swamp_hut: 14357620,
  };
  const SPACING = 32, SEPARATION = 8;

  Temples.prototype.inRegion = function (kind, rx, rz) {
    const w = this.world;
    const rng = new JavaRandom();
    setRegionSeed(rng, w.levelSeed, rx, rz, SETS[kind]);
    const cx = rx * SPACING + rng.nextWithin(SPACING - SEPARATION);
    const cz = rz * SPACING + rng.nextWithin(SPACING - SEPARATION);
    setCarverSeed(rng, w.levelSeed, cx, cz);
    return STARTS[kind](this, rng, cx, cz);
  };

  function regionOf(lx, lz) {
    const cx = Math.floor(lx / 16), cz = Math.floor((-lz - 1) / 16);
    return [Math.floor(cx / SPACING), Math.floor(cz / SPACING)];
  }

  const api = { Temples, regionOf, SPACING, KINDS: Object.keys(SETS) };
  if (isNode) module.exports = api;
  else root.MclTemples = api;
})(typeof self !== 'undefined' ? self : this);
