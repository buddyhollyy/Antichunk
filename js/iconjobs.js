// Structure finding for the map icons, shared by the page and the workers.
// A job is [layer, ...args]; the same job gives the same result on either
// side.  Workers send results back as plain data (functions dropped); the
// page works out the slower extras (like centerY) itself when asked.
(function (root) {
  'use strict';
  function Finders(seedText) {
    const world = new root.MclVillages.World(seedText);
    this.world = world;
    this.portals = new root.MclPortals.Portals(world);
    this.temples = new root.MclTemples.Temples(world);
    this.ocean = new root.MclOcean.Ocean(world);
    this.land = new root.MclLandmarks.Landmarks(world);
    this.nether = new root.MclNether.Nether(world);
  }
  Finders.prototype.run = function (job) {
    const [layer, a, b, c] = job;
    switch (layer) {
      case 'village': return root.MclVillages.villageInRegion(this.world, a, b);
      case 'portal': return this.portals.inRegion(a, b);
      case 'nether': return this.nether.inRegion(a, b);
      case 'netherPortal': return this.nether.ruinedPortal(a, b);
      case 'temple': return this.temples.inRegion(a, b, c);
      case 'ocean': return this.ocean[a](b, c);
      case 'land': return this.land[a](b, c);
    }
    throw new Error('unknown icon job ' + layer);
  };
  function plain(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(plain);
    const o = {};
    for (const k of Object.keys(v)) if (typeof v[k] !== 'function') o[k] = plain(v[k]);
    return o;
  }
  root.MclIconJobs = { Finders, plain };
})(typeof self !== 'undefined' ? self : this);
