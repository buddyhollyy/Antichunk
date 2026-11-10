// Main page logic: view state, tile scheduling, drawing, grid and input.
(function () {
  'use strict';
  const N = window.LuantiNoise;
  const CHUNK = 80, OFF = -32;

  // ------------------------------------------------------------ elements
  const canvas = document.getElementById('map');
  let ctx = canvas.getContext('2d'); // swapped briefly to draw the type buttons
  const seedInput = document.getElementById('seed');
  const form = document.getElementById('seed-form');
  const gotoForm = document.getElementById('goto-form');
  const gotoX = document.getElementById('goto-x');
  const gotoZ = document.getElementById('goto-z');
  const readout = document.getElementById('readout');
  const status = document.getElementById('status');
  const seedInfo = document.getElementById('seed-info');

  // ------------------------------------------------------------ state
  const ZOOMS = [8, 4, 2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32, 1 / 64]; // screen px per node
  // Edges of the Luanti world: X and Z run from -30912 to 30927 with the
  // default mapgen_limit of 31007 (docs.luanti.org, World Boundaries).  A
  // world made with a smaller mapgen_limit ends sooner; see setLimit().
  let mapgenLimit = 31007, WORLD_MIN = -30912, WORLD_MAX = 30927, PORTAL_EDGE = 30912;
  // Luanti's get_mapgen_edges (src/mapgen/mapgen.cpp) for chunksize 5:
  // only mapchunks wholly inside the limit are generated.
  function mapgenEdges(limit) {
    const lb = Math.trunc(Math.max(0, Math.min(limit, 31007)) / 16);
    const lmin = -lb * 16, lmax = (lb + 1) * 16 - 1;
    const cs = 80, ccmin = -32, ccmax = 47, ccfmin = -48, ccfmax = 63;
    const nmin = Math.max(Math.trunc((ccfmin - lmin) / cs), 0), nmax = Math.max(Math.trunc((lmax - ccfmax) / cs), 0);
    return [ccmin - nmin * cs, ccmax + nmax * cs];
  }
  const view = { x: 0, z: 0, zi: 3 };              // center and zoom index
  let seedText = '', seed32 = 0, seed64 = '0', generation = 0;
  let mouse = null;                                 // last pointer pos (css px)
  let mode = 'biomes';                              // 'biomes' or 'terrain'
  let dim = 'overworld';                            // 'overworld' or 'nether'

  // ------------------------------------------------------------ workers
  const hint = document.getElementById('hint');
  const workerSrc = document.getElementById('worker-src').textContent;
  const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
  const nWorkers = Math.max(2, Math.min(16, (navigator.hardwareConcurrency || 4) - 1));
  const workers = [];
  const cache = new Map();    // key -> {img, size, surface, water, used}
  let queue = [];             // keys waiting
  const queued = new Set();
  const inFlight = new Map(); // key -> worker
  for (let w = 0; w < nWorkers; w++) {
    const wk = new Worker(workerUrl);
    wk.busy = false;
    wk.onmessage = (e) => onTile(wk, e.data);
    wk.onerror = (e) => { status.textContent = 'Worker error: ' + e.message; };
    workers.push(wk);
  }

  function key(step, cx, cz) { return dim[0] + ':' + step + ':' + cx + ':' + cz; }
  // Zoomed out, one tile covers g x g mapchunks (g = step / 2), so a screen
  // needs about the same number of tiles at every zoom level.
  // Sample spacings used for tiles.  Each must divide 80 so that samples
  // line up across mapchunks; 40 (not 32) is used for the furthest zoom.
  const STEPS = [1, 2, 4, 8, 16, 40, 80];
  const coarser = (step) => STEPS[STEPS.indexOf(step) + 1];
  const finer = (step) => STEPS.slice(Math.max(0, STEPS.indexOf(step) - 2), STEPS.indexOf(step)).reverse();
  const tileChunks = (step) => (step >= 4 ? step / 2 : 1);
  const tileSpan = (step) => CHUNK * tileChunks(step);
  const tileOrigin = (v, step) => Math.floor((v - OFF) / tileSpan(step)) * tileSpan(step) + OFF;
  // The loaded tile sample under world (x, z), finest first.
  function sampleAt(x, z) {
    for (const st of STEPS) {
      const tx = tileOrigin(x, st), tz = tileOrigin(z, st);
      const t = cache.get(key(st, tx, tz));
      if (t) return { t, st, idx: Math.floor((z - tz) / st) * t.size + Math.floor((x - tx) / st) };
    }
    return null;
  }

  function onTile(wk, d) {
    wk.busy = false;
    if (d.icons) { wk.icons = false; onIcons(d); return; }
    const [gen, k] = d.id.split('|');
    inFlight.delete(k);
    aheadInFlight.delete(k);
    if (Number(gen) === generation) { addTile(k, d); saveTile(k, d); }
    requestDrawSoon();
    pump();
  }
  function addTile(k, d) {
    const toCanvas = (px) => {
      const c = document.createElement('canvas');
      c.width = c.height = d.size;
      c.getContext('2d').putImageData(new ImageData(px, d.size, d.size), 0, 0);
      return c;
    };
    const img = toCanvas(d.rgba);
    cache.set(k, { img, imgB: d.rgbaB ? toCanvas(d.rgbaB) : img, size: d.size,
      surface: d.surface, water: d.water, biome: d.biome, used: performance.now() });
    trimCache();
  }

  // ------------------------------------------------------------ saved tiles
  // Finished map tiles and structure results are kept in the browser
  // (IndexedDB), so a seed seen before shows at once.  At most about 100 MB;
  // the oldest entries go first.  The key starts with a fingerprint of the
  // map code, so anything saved by a different version is never used and is
  // cleared out.  If the browser refuses storage, everything still works.
  const STORE_VERSION = '/*@BUILDHASH@*/';
  const STORE_CAP = 100e6, STORE_LOW = 85e6;
  const store = { db: null, keys: new Set(), total: 0, reading: 0, evicting: false, iconReads: [] };
  const storePrefix = () => STORE_VERSION + '|' + seed64 + '|';
  async function gzip(u8, compress) {
    const cs = compress ? new CompressionStream('gzip') : new DecompressionStream('gzip');
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer());
  }
  function openStore() {
    if (typeof indexedDB === 'undefined' || typeof CompressionStream === 'undefined') return;
    holdFor(400);
    try {
      const req = indexedDB.open('antichunk', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('data');
        db.createObjectStore('meta').createIndex('t', 't');
      };
      req.onsuccess = () => {
        const db = req.result;
        store.db = db;
        loadStoreKeys();
        // Then, in the background, count what is stored and drop anything
        // saved by other versions.
        const tx = db.transaction(['meta', 'data'], 'readwrite');
        const meta = tx.objectStore('meta'), data = tx.objectStore('data');
        meta.openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return;
          if (!String(c.key).startsWith(STORE_VERSION + '|')) { meta.delete(c.key); data.delete(c.key); }
          else store.total += c.value.n;
          c.continue();
        };
        tx.oncomplete = () => { if (store.total > STORE_CAP) evictStore(); };
      };
      req.onerror = req.onblocked = () => holdFor(0);
    } catch (e) { /* storage blocked */ }
  }
  // While the list of saved tiles is being read (normally a few
  // milliseconds), the threads wait, so they don't redo saved work.
  let holdUntil = 0;
  function holdFor(ms) { holdUntil = performance.now() + ms; if (!ms) pump(); else setTimeout(pump, ms + 5); }
  function loadStoreKeys() {
    store.keys = new Set();
    if (!store.db || !seedText) return;
    const pre = storePrefix(), want = seed64;
    holdFor(400);
    try {
      const r = store.db.transaction('meta').objectStore('meta').getAllKeys(IDBKeyRange.bound(pre, pre + '\uffff'));
      r.onsuccess = () => { if (seed64 === want) { store.keys = new Set(r.result.map((k) => k.slice(pre.length))); holdFor(0); requestDraw(); } };
      r.onerror = () => holdFor(0);
    } catch (e) { holdFor(0); }
  }
  function storePut(k, buf) {
    if (!store.db) return;
    try {
      const tx = store.db.transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('data').put(buf, k);
      tx.objectStore('meta').put({ n: buf.byteLength, t: Date.now() }, k);
      tx.oncomplete = () => { store.total += buf.byteLength; if (store.total > STORE_CAP) evictStore(); };
    } catch (e) { /* full or blocked */ }
  }
  function evictStore() {
    if (store.evicting || !store.db) return;
    store.evicting = true;
    const tx = store.db.transaction(['meta', 'data'], 'readwrite');
    const meta = tx.objectStore('meta'), data = tx.objectStore('data');
    meta.index('t').openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c || store.total <= STORE_LOW) return;
      store.total -= c.value.n;
      const k = c.primaryKey;
      meta.delete(k); data.delete(k);
      const pre = storePrefix();
      if (k.startsWith(pre)) store.keys.delete(k.slice(pre.length));
      c.continue();
    };
    tx.oncomplete = tx.onerror = () => { store.evicting = false; };
  }
  async function saveTile(k, d) {
    if (!store.db || store.keys.has(k)) return;
    const name = storePrefix() + k;
    store.keys.add(k);
    const parts = [d.rgba, d.rgbaB, d.surface, d.water, d.biome].map((a) => (a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(0)));
    const head = new Int32Array([d.size, ...parts.map((p) => p.length)]);
    const all = new Uint8Array(head.byteLength + parts.reduce((n, p) => n + p.length, 0));
    all.set(new Uint8Array(head.buffer), 0);
    let o = head.byteLength;
    for (const p of parts) { all.set(p, o); o += p.length; }
    try { storePut(name, (await gzip(all, true)).buffer); } catch (e) { store.keys.delete(k); }
  }
  function readTile(k) {
    const gen = generation, name = storePrefix() + k;
    inFlight.set(k, 'store'); store.reading++;
    const fail = () => {
      store.reading--; inFlight.delete(k); store.keys.delete(k);
      if (gen === generation && !queued.has(k)) { queue.unshift(k); queued.add(k); }
      pump();
    };
    try {
      const r = store.db.transaction('data').objectStore('data').get(name);
      r.onerror = fail;
      r.onsuccess = async () => {
        if (!r.result) { fail(); return; }
        try {
          const all = await gzip(new Uint8Array(r.result), false);
          const head = new Int32Array(all.buffer.slice(0, 24));
          let o = 24;
          const take = (n) => { const b = all.buffer.slice(o, o + n); o += n; return b; };
          const rgba = new Uint8ClampedArray(take(head[1])), rgbaB = head[2] ? new Uint8ClampedArray(take(head[2])) : (take(0), null);
          const d = { size: head[0], rgba, rgbaB, surface: new Int16Array(take(head[3])),
            water: new Uint8Array(take(head[4])), biome: new Uint8Array(take(head[5])) };
          store.reading--; inFlight.delete(k); aheadInFlight.delete(k);
          if (gen === generation) { addTile(k, d); requestDrawSoon(); }
          pump();
        } catch (e) { fail(); }
      };
    } catch (e) { fail(); }
  }
  openStore();

  // Structure results: small, saved as JSON without compression.
  function saveIcon(id, res) {
    if (!store.db || store.keys.has('i|' + id)) return;
    store.keys.add('i|' + id);
    const enc = new TextEncoder().encode(JSON.stringify(res === undefined ? null : res));
    storePut(storePrefix() + 'i|' + id, enc.buffer);
  }
  function flushIconReads() {
    const list = store.iconReads;
    if (!list.length || !store.db) return;
    store.iconReads = [];
    const gen = iconGen, pre = storePrefix();
    try {
      const os = store.db.transaction('data').objectStore('data');
      for (const { id, job } of list) {
        const r = os.get(pre + 'i|' + id);
        const fail = () => { iconSent.delete(id); store.keys.delete('i|' + id); requestDrawSoon(); };
        r.onerror = fail;
        r.onsuccess = () => {
          if (gen !== iconGen) return;
          if (!r.result) { fail(); return; }
          iconSent.delete(id);
          const res = JSON.parse(new TextDecoder().decode(r.result));
          iconCaches()[job[0]].set(id.slice(id.indexOf('|') + 1), withExtras(insideWorld(res), job));
          requestDrawSoon();
        };
      }
    } catch (e) { for (const { id } of list) iconSent.delete(id); }
  }

  function pump() {
    // Tiles saved earlier come from browser storage instead of a thread.
    if (store.keys.size) {
      for (let i = 0; i < queue.length && store.reading < 24;) {
        const k = queue[i];
        if (store.keys.has(k)) { queue.splice(i, 1); queued.delete(k); readTile(k); } else i++;
      }
    }
    flushIconReads();
    if (performance.now() < holdUntil) { updateStatus(); return; }
    for (const wk of workers) {
      if (wk.busy) continue;
      if (findQueue.length) {   // "Find nearest" comes before everything else
        const batch = findQueue.splice(0, 6);
        for (const j of batch) { findQueued.delete(j.id); iconSent.set(j.id, j.job); }
        wk.busy = true; wk.icons = true;
        wk.postMessage({ icons: batch.map((j) => [j.id, j.job]), seedText, gen: iconGen });
        continue;
      }
      if (iconQueue.length && (iconWorkers() < Math.ceil(nWorkers / 2) || !queue.length)) {
        const batch = iconQueue.splice(0, 24);
        for (const j of batch) { iconQueued.delete(j.id); iconSent.set(j.id, j.job); }
        wk.busy = true; wk.icons = true;
        wk.postMessage({ icons: batch.map((j) => [j.id, j.job]), seedText, gen: iconGen });
        continue;
      }
      let k = queue.shift();
      if (k !== undefined) queued.delete(k);
      else if (!iconQueue.length) {
        while (aheadQueue.length && (cache.has(aheadQueue[0]) || inFlight.has(aheadQueue[0]) || store.keys.has(aheadQueue[0]))) {
          const a = aheadQueue.shift();
          if (store.keys.has(a) && !cache.has(a) && !inFlight.has(a) && store.reading < 24) { aheadInFlight.add(a); readTile(a); }
        }
        k = aheadQueue.shift();
        if (k !== undefined) aheadInFlight.add(k);
      }
      if (k === undefined) break;
      const [d, step, cx, cz] = k.split(':');
      wk.busy = true;
      inFlight.set(k, wk);
      wk.postMessage({ id: generation + '|' + k, seed: seed32, cx: +cx, cz: +cz, step: +step, g: tileChunks(+step),
        nether: d === 'n', end: d === 'e', seed64 });
    }
    updateStatus();
  }

  // ------------------------------------------------------------ icon jobs
  // Structure finding runs on the same worker threads as the map tiles.
  // Each draw lists the regions it still needs (nearest the center first);
  // results come back as plain data and land in the layer's cache.
  let iconQueue = [], iconGen = 0, mainFinders = null;
  const iconQueued = new Set(), iconSent = new Map(); // id -> job
  const iconWorkers = () => workers.reduce((n, w) => n + (w.busy && w.icons ? 1 : 0), 0);
  function iconCaches() {
    return { village: villageCache, portal: portalCache, nether: netherCache, netherPortal: netherPortalCache,
      temple: templeCache, ocean: oceanCache, land: landCache };
  }
  // Ask for the result of job for cache key k; it arrives later.
  function ask(k, job, wx, wz) {
    if (wx < WORLD_MIN - 1500 || wx > WORLD_MAX + 1500 || wz < WORLD_MIN - 1500 || wz > WORLD_MAX + 1500) return;
    const id = job[0] + '|' + k;
    if (iconSent.has(id) || iconQueued.has(id)) return;
    if (store.keys.has('i|' + id)) { iconSent.set(id, job); store.iconReads.push({ id, job }); return; }
    iconQueued.add(id);
    iconQueue.push({ id, job, d: Math.hypot(wx - view.x, wz - view.z) });
  }
  function onIcons(d) {
    if (d.gen === iconGen) {
      const caches = iconCaches();
      for (const [id, res] of d.icons) {
        const job = iconSent.get(id);
        iconSent.delete(id);
        saveIcon(id, res);
        caches[job[0]].set(id.slice(id.indexOf('|') + 1), withExtras(insideWorld(res), job));
      }
      requestDrawSoon();
      if (finding) setTimeout(findTick, 0);
    }
    pump();
  }
  // Structures whose position is past the world's edge are never built.
  const inWorld = (o) => o.x >= WORLD_MIN && o.x <= WORLD_MAX && o.z >= WORLD_MIN && o.z <= WORLD_MAX;
  function insideWorld(res) {
    if (!res) return res;
    if (Array.isArray(res)) return res.filter(inWorld);
    return inWorld(res) ? res : null;
  }
  // Workers drop functions such as centerY(); this page works them out
  // again for the one structure that is hovered or clicked.
  function withExtras(res, job) {
    if (!res) return res;
    let full;
    const getFull = () => full || (full = mainFinders.run(job));
    const fix = (o, i) => {
      o.centerY = () => { const f = getFull(); const m = Array.isArray(f) ? f[i] : f; return m && m.centerY ? m.centerY() : null; };
      return o;
    };
    return Array.isArray(res) ? res.map(fix) : fix(res, 0);
  }

  function trimCache() {
    const LIMIT = Math.max(4000, Math.ceil(visibleCount * 6));
    if (cache.size <= LIMIT + 500) return;
    const entries = [...cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < entries.length - LIMIT; i++) cache.delete(entries[i][0]);
  }

  function updateStatus() {
    let pending = queue.length + inFlight.size;
    for (const k of aheadInFlight) if (inFlight.has(k)) pending--;
    status.textContent = pending ? 'Loading ' + pending + ' map tile' + (pending === 1 ? '' : 's') +
      ' on ' + nWorkers + ' threads…' : '';
  }

  // ------------------------------------------------------------ geometry
  function scale() { return ZOOMS[view.zi]; }
  function stepFor(s) { return s >= 1 ? 1 : 1 / s <= 16 ? Math.round(1 / s) : 1 / s <= 32 ? 40 : 80; }
  // Reading clientWidth is slow when called thousands of times per frame,
  // so the size is kept and refreshed once per frame and on resize.
  let curSize = null;
  function size() { return curSize || (curSize = { w: canvas.clientWidth, h: canvas.clientHeight }); }
  window.addEventListener('resize', () => { curSize = null; });
  // world (x, z) -> screen (css px). +Z (north) is up.
  function toScreen(x, z) {
    const s = scale(), { w, h } = size();
    return [w / 2 + (x - view.x) * s, h / 2 - (z - view.z) * s];
  }
  function toWorld(px, py) {
    const s = scale(), { w, h } = size();
    return [view.x + (px - w / 2) / s, view.z - (py - h / 2) / s];
  }
  function chunkOrigin(v) { return Math.floor((v - OFF) / CHUNK) * CHUNK + OFF; }

  // ------------------------------------------------------------ drawing
  let drawPending = false, lastViewKey = '', visibleCount = 0, frameDeadline = 0;
  function requestDraw() {
    if (!drawPending) { drawPending = true; requestAnimationFrame(draw); }
  }

  // While tiles stream in, redraw at most a few times per second.
  let soonTimer = 0;
  function requestDrawSoon() {
    if (!soonTimer) soonTimer = setTimeout(() => { soonTimer = 0; requestDraw(); }, 150);
  }

  function draw() {
    drawPending = false;
    curSize = null;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, w, h);
    if (!seedText) { updateReadout(); return; }

    const s = scale(), step = stepFor(s);
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    const span = tileSpan(step);
    const cx0 = tileOrigin(x0, step), cx1 = tileOrigin(x1, step);
    const cz0 = tileOrigin(z0, step), cz1 = tileOrigin(z1, step);
    ctx.imageSmoothingEnabled = false;

    const wanted = [];
    const now = performance.now();
    const useB = mode === 'biomes' || dim !== 'overworld';
    const drawn = new Set(), preview = new Set();
    const hlOn = !!hlFlags && dim !== 'end';
    hlSeen = false;
    // Tile covers x in [tx, tx+span), z in [tz, tz+span): top-left is (tx, tz+span).
    const put = (t, tx, tz, sp) => {
      t.used = now;
      const [sx, sy] = toScreen(tx, tz + sp);
      const side = sp * s;
      const r = [Math.floor(sx), Math.floor(sy), Math.ceil(side + (sx % 1)), Math.ceil(side + (sy % 1))];
      ctx.drawImage(useB ? t.imgB : t.img, ...r);
      if (hlOn) { ctx.drawImage(maskFor(t), ...r); if (t.maskAny) hlSeen = true; }
    };
    for (let cz = cz0; cz <= cz1; cz += span) {
      for (let cx = cx0; cx <= cx1; cx += span) {
        const k = key(step, cx, cz);
        const t = cache.get(k);
        if (t) { put(t, cx, cz, span); continue; }
        wanted.push(k);
        // While waiting, show coarser tiles, or the finer ones, already loaded.
        // Tiles of different steps need not line up, so look at every tile
        // of that step that overlaps this one.
        const each = (st, fn) => {
          const sp = tileSpan(st);
          for (let z = tileOrigin(cz, st); z < cz + span; z += sp)
            for (let x = tileOrigin(cx, st); x < cx + span; x += sp) fn(key(st, x, z), x, z, sp);
        };
        let shown = false;
        for (let st = coarser(step); st && !shown; st = coarser(st)) {
          let all = true;
          each(st, (kk) => { if (!cache.has(kk)) all = false; });
          if (!all) continue;
          each(st, (kk, x, z, sp) => { if (!drawn.has(kk)) { drawn.add(kk); put(cache.get(kk), x, z, sp); } });
          shown = true;
        }
        if (shown) continue;
        // Nothing coarser is loaded yet: also ask for the tiles one zoom level
        // coarser.  They cost far less, so the screen fills in quickly with a
        // rough picture that the sharp tiles then replace.
        if (coarser(step)) each(coarser(step), (kk) => { if (!preview.has(kk) && !cache.has(kk)) { preview.add(kk); wanted.push(kk); } });
        for (const st of finer(step)) each(st, (kk, x, z, sp) => { const c = cache.get(kk); if (c) put(c, x, z, sp); });
      }
    }
    // Only re-plan the work queue when the view itself changed, not every
    // time a finished tile arrives (that would be slow with many tiles).
    const viewKey = dim + ':' + generation + ':' + view.zi + ':' + cx0 + ':' + cx1 + ':' + cz0 + ':' + cz1;
    visibleCount = ((cx1 - cx0) / span + 1) * ((cz1 - cz0) / span + 1);
    if (viewKey !== lastViewKey) { lastViewKey = viewKey; planAhead(step, x0, x1, z0, z1); schedule(wanted); }
    // Outline the world's edge.  The terrain past it is still drawn (what
    // the noise would give there), though nothing is ever built there.
    {
      const [ex0, ez1] = toScreen(WORLD_MIN, WORLD_MAX + 1), [ex1, ez0] = toScreen(WORLD_MAX + 1, WORLD_MIN);
      if (ex0 > -2 || ex1 < w + 2 || ez1 > -2 || ez0 < h + 2) {
        const r = [Math.round(ex0) + 0.5, Math.round(ez1) + 0.5, Math.round(ex1 - ex0) - 1, Math.round(ez0 - ez1) - 1];
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3; ctx.strokeRect(...r);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1; ctx.strokeRect(...r);
      }
    }
    drawGrid(w, h, s);
    // All structure layers together get at most ~40 ms of new work per
    // frame; whatever is left is picked up on the very next frame, so the
    // icons keep coming in while the map stays responsive (~25 frames/s).
    frameDeadline = performance.now() + 40;
    iconQueue = []; iconQueued.clear();
    // Forget last frame's icons; each layer drawn below lists its own again.
    shownVillages = []; shownPortals = []; shownNether = []; shownEnd = [];
    shownTemples = []; shownOcean = []; shownLand = []; shownStrong = [];
    zoomHidden = false; slimeHidden = false;
    const far = false;
    if (dim === 'overworld' && showSlime) drawSlime(w, h);   // under all the icons
    if (dim === 'nether') {
      if (showNether && !far) drawNether(w, h);
    } else if (dim === 'end') {
      if (showEnd) drawEnd(w, h);
    } else {
      if (!far) {
        if (showPortals) drawPortals(w, h);
        if (showOcean) drawOcean(w, h);
        if (showLand) drawLand(w, h);
      }
      if (showStrong) drawStrongholds(w, h);
      if (showSpawn) drawSpawn(w, h);
      if (!far) {
        if (showTemples) drawTemples(w, h);
        if (showVillages) drawVillages(w, h, s);
      }
    }
    if (showWp) drawWaypoints(w, h);
    drawRuler();
    iconQueue.sort((a, b) => a.d - b.d);
    pump();
    // Notes at the top of the map.
    const notes = [];
    if (zoomHidden) notes.push('Zoom in to see all structures');
    if (slimeHidden) notes.push('Zoom in to see slime chunks');
    if (hlOn && !hlSeen && !wanted.length) notes.push('No ' + hlSelect.options[hlSelect.selectedIndex].text + ' on screen. Zoom out to look further.');
    hint.textContent = notes.join(' · ');
    hint.hidden = !notes.length;
    // Mark the panel entries that this zoom level leaves off the map.
    for (const [kind, b] of typeButtons) {
      const m = MIN_SCALE[/^village_/.test(kind) ? 'village' : kind === 'fortress' || kind === 'bastion' ? 'nether' : kind];
      const far = !!m && s < m - 1e-9;
      if (b.classList.contains('far') !== far) {
        b.classList.toggle('far', far);
        b.title = far ? 'Zoom in to see these on the map' : b.dataset.title;
      }
    }
    drawSelection();
    if (pendingSel) setTimeout(findPending, 0);
    // A card opened before its map tile had loaded gets its biome now.
    if (selected && selected.waitTile && sampleAt(selected.v.x, selected.v.z)) showInfo();
    updateReadout();
  }

  // ------------------------------------------------------------ load ahead
  // When the screen is finished and the threads are idle, they go on with
  // the next zoom level out and then a band half a screen wide around the
  // view, so zooming out or panning finds those tiles ready.  Left off on
  // phones and tablets (touch screens) and when the browser asks to save
  // data, to spare battery.
  const AHEAD = !(window.matchMedia && matchMedia('(pointer: coarse)').matches) &&
    !(navigator.connection && navigator.connection.saveData);
  let aheadQueue = [];
  const aheadInFlight = new Set();
  function planAhead(step, x0, x1, z0, z1) {
    aheadQueue = [];
    if (!AHEAD || !seedText) return;
    const cxm = (x0 + x1) / 2, czm = (z0 + z1) / 2, hw = (x1 - x0) / 2, hh = (z1 - z0) / 2;
    const add = (st, ax0, ax1, az0, az1, list) => {
      const sp = tileSpan(st);
      for (let z = tileOrigin(az0, st); z <= az1; z += sp) for (let x = tileOrigin(ax0, st); x <= ax1; x += sp) {
        if (x > WORLD_MAX + sp || z > WORLD_MAX + sp || x + sp < WORLD_MIN - sp || z + sp < WORLD_MIN - sp) continue;
        list.push([key(st, x, z), Math.hypot(x + sp / 2 - cxm, z + sp / 2 - czm)]);
      }
    };
    const out = [], ring = [];
    if (view.zi + 1 < ZOOMS.length) add(stepFor(ZOOMS[view.zi + 1]), cxm - 2 * hw, cxm + 2 * hw, czm - 2 * hh, czm + 2 * hh, out);
    add(step, x0 - hw, x1 + hw, z0 - hh, z1 + hh, ring);
    out.sort((a, b) => a[1] - b[1]); ring.sort((a, b) => a[1] - b[1]);
    aheadQueue = out.concat(ring).map((e) => e[0]);
  }

  function schedule(wanted) {
    // Keep only tiles that are still visible, nearest to the center first.
    const want = new Set(wanted);
    queue = queue.filter((k) => want.has(k));
    queued.clear();
    for (const k of queue) queued.add(k);
    for (const k of wanted) {
      aheadInFlight.delete(k);   // needed now, so it counts as loading again
      if (!queued.has(k) && !inFlight.has(k)) { queue.push(k); queued.add(k); }
    }
    const d = new Map();
    for (const k of queue) {
      const [, step, cx, cz] = k.split(':').map(Number);
      const half = tileSpan(step) / 2;
      d.set(k, Math.hypot(cx + half - view.x, cz + half - view.z));
    }
    // Rough preview tiles (coarser than the current zoom level) go first.
    const fine = stepFor(scale());
    const rank = (k) => (Number(k.split(':')[1]) > fine ? 0 : 1);
    queue.sort((a, b) => rank(a) - rank(b) || d.get(a) - d.get(b));
    pump();
  }

  const NICE = [10, 16, 20, 50, 80, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  function drawGrid(w, h, s) {
    let spacing = NICE[NICE.length - 1];
    for (const n of NICE) if (n * s >= 70) { spacing = n; break; }
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';

    const lines = (from, to, fn) => {
      for (let v = Math.ceil(from / spacing) * spacing; v <= to; v += spacing) fn(v);
    };
    // Grid lines
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    lines(x0, x1, (x) => { const px = Math.round(toScreen(x, 0)[0]) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, h); });
    lines(z0, z1, (z) => { const py = Math.round(toScreen(0, z)[1]) + 0.5; ctx.moveTo(0, py); ctx.lineTo(w, py); });
    ctx.stroke();
    // Axes x = 0 and z = 0
    ctx.strokeStyle = 'rgba(200,30,30,0.75)';
    ctx.beginPath();
    const [ax, az] = toScreen(0, 0);
    if (ax >= 0 && ax <= w) { ctx.moveTo(Math.round(ax) + 0.5, 0); ctx.lineTo(Math.round(ax) + 0.5, h); }
    if (az >= 0 && az <= h) { ctx.moveTo(0, Math.round(az) + 0.5); ctx.lineTo(w, Math.round(az) + 0.5); }
    ctx.stroke();
    // Labels along the top (x) and left (z) edges
    const label = (text, px, py) => {
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(20,22,26,0.75)';
      ctx.fillRect(px - 2, py - 1, tw + 4, 14);
      ctx.fillStyle = '#f2f2f2';
      ctx.fillText(text, px, py);
    };
    lines(x0, x1, (x) => label('x ' + x, Math.round(toScreen(x, 0)[0]) + 3, 4));
    lines(z0, z1, (z) => label('z ' + z, 4, Math.round(toScreen(0, z)[1]) + 3));
  }

  // ------------------------------------------------------------ readout
  function updateReadout() {
    if (!mouse || !seedText) { readout.textContent = ''; return; }
    const [wx, wz] = toWorld(mouse[0], mouse[1]);
    const x = Math.floor(wx), z = Math.floor(wz);
    const at = sampleAt(x, z);
    let text = 'X ' + x + '   Z ' + z;
    if (dim === 'end') {
      if (at) {
        const y = at.t.surface[at.idx];
        text += '   ' + (y === -32768 ? 'void' : (at.st === 1 ? 'top block Y ' : 'top block Y ≈ ') + y) +
          '   ' + ['main island area', 'inner ring of islands', 'outer islands'][at.t.biome[at.idx]];
      }
      const o = endNear(mouse[0], mouse[1]);
      if (o) text += '   •   ' + endTitle(o) + ' at X ' + o.x + (o.y === null ? '' : ', Y ' + o.y) + ', Z ' + o.z;
      readout.textContent = text;
      return;
    }
    if (dim === 'nether') {
      text += '   (overworld X ' + x * 8 + ', Z ' + z * 8 + ')';
      if (at) text += '   ' + NETHER_LABEL[window.LuantiBiomes.BIOMES[at.t.biome[at.idx]].name];
      const o = netherNear(mouse[0], mouse[1]);
      if (o) text += '   •   ' + (o.giant ? 'Large ruined portal' : NETHER_KIND[o.kind]) +
        (o.kind === 'nether_portal' ? '' : ' (' + (o.kind === 'fortress' ? 'starting chunk' : 'starting room') + ')') + ' at X ' + o.x + (o.y === null ? '' : ', Y ' + o.y) + ', Z ' + o.z;
      readout.textContent = text;
      return;
    }
    // Exact height if the full-detail tile is loaded, else nearest sample.
    if (at) {
      const y = at.t.surface[at.idx];
      text += '   ' + (at.st === 1 ? 'top block Y ' : 'top block Y ≈ ') + y + (at.t.water[at.idx] ? ' (under water)' : '');
      text += '   ' + biomeLabel(window.LuantiBiomes.BIOMES[at.t.biome[at.idx]].name);
    }
    const v = villageNear(mouse[0], mouse[1]);
    if (v) {
      text += '   •   ' + (v.zombie ? 'Abandoned ' : '') + VILLAGE_LABEL[v.type] + ' village at X ' + v.x + ', Z ' + v.z;
    } else if (spawnNear(mouse[0], mouse[1])) {
      const o = spawnInfo.nearest;
      text += '   •   Spawn: nearest suitable spot to 0,0 at X ' + o.x + ', Y ' + o.y + ', Z ' + o.z +
        '; new players appear within about ' + spawnInfo.reach + ' nodes of 0,0';
    } else if (strongNear(mouse[0], mouse[1])) {
      const o = strongNear(mouse[0], mouse[1]);
      text += '   •   Stronghold (starting chunk, ring ' + o.ring + ') at X ' + o.x + ', Z ' + o.z;
    } else if (landNear(mouse[0], mouse[1])) {
      const o = landNear(mouse[0], mouse[1]);
      const label = { treasure: 'Buried treasure', mineshaft: o.mesa ? 'Mesa mineshaft (starting chunk)' : 'Mineshaft (starting chunk)',
        mansion: 'Woodland mansion (start point)', outpost: 'Pillager outpost', trail_ruins: 'Trail ruins (starting room)',
        trial_chambers: 'Trial chambers (starting room)' }[o.kind];
      const y = o.centerY();
      text += '   •   ' + label + ' at X ' + o.x + (y === null ? '' : ', Y ' + y) + ', Z ' + o.z;
    } else if (oceanNear(mouse[0], mouse[1])) {
      const o = oceanNear(mouse[0], mouse[1]);
      let label = 'Ocean monument';
      if (o.kind === 'shipwreck') label = 'Shipwreck';
      else if (o.kind === 'ocean_ruin') {
        label = (o.large ? 'Large ' : '') + o.temp + ' ocean ruin' + (o.count > 1 ? ' (group of ' + o.count + ')' : '');
        label = label[0].toUpperCase() + label.slice(1);
      }
      text += '   •   ' + label + ' at X ' + o.x + ', Y ' + o.centerY() + ', Z ' + o.z;
    } else if (templeNear(mouse[0], mouse[1])) {
      const t = templeNear(mouse[0], mouse[1]);
      text += '   •   ' + TEMPLE_LABEL[t.kind] + ' at X ' + t.x + ', Y ' + t.centerY() + ', Z ' + t.z +
        (t.kind === 'igloo' && t.basement ? ', with basement' : '');
    } else {
      const p = portalNear(mouse[0], mouse[1]);
      if (p) {
        text += '   •   ' + (p.giant ? 'Large ruined portal' : 'Ruined portal') +
          (p.kind === 'standard' ? '' : ' (' + p.kind + ')') + ' at X ' + p.x + ', Y ' + p.y + ', Z ' + p.z +
          (p.placement === 'underground' || p.placement === 'in_mountain' ? ', buried' : '');
      }
    }
    readout.textContent = text;
  }

  // ------------------------------------------------------------ villages
  // Placement regions are 34 x 34 Mineclonia chunks (544 x 544 nodes).
  // Each region has at most one village; results are cached per region.
  const VILLAGE_COLOR = { plains: '#f4d35e', desert: '#ee964b', savannah: '#c8a2c8', snowy: '#9ad1ff', taiga: '#7bd389' };
  const VILLAGE_LABEL = { plains: 'Plains', desert: 'Desert', savannah: 'Savanna', snowy: 'Snowy', taiga: 'Taiga' };
  let world = null, showVillages = true;
  // Structure types switched off with the icon buttons, e.g. "igloo".
  const hiddenKinds = new Set();
  const villageCache = new Map();
  let shownVillages = [];

  // Zoomed out, common structures are left off (and not worked out), like
  // other seed maps do: each kind shows only down to this many screen
  // pixels per node.  Kinds not listed (mansions, strongholds, spawn and
  // the End's features) show at every zoom level.
  const MIN_SCALE = {
    treasure: 1 / 4, mineshaft: 1 / 4, shipwreck: 1 / 4, ocean_ruin: 1 / 4,
    portal: 1 / 4, trail_ruins: 1 / 4, trial_chambers: 1 / 4, slime: 1 / 4,
    village: 1 / 16, desert_pyramid: 1 / 16, jungle_temple: 1 / 16, igloo: 1 / 16, swamp_hut: 1 / 16,
    monument: 1 / 16, outpost: 1 / 16, nether: 1 / 16, nether_portal: 1 / 16,
  };
  let zoomHidden = false;
  function hiddenByZoom(kind) {
    const m = MIN_SCALE[kind];
    if (m && scale() < m - 1e-9) { zoomHidden = true; return true; }
    return false;
  }

  function drawVillages(w, h) {
    const V = window.MclVillages;
    const R = V.SPACING * 16;
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    // Region index ranges (Mineclonia z is flipped, so map both corners).
    const ra = V.regionOf(Math.floor(x0) - R, Math.floor(z1) + R);
    const rb = V.regionOf(Math.floor(x1) + R, Math.floor(z0) - R);
    const rx0 = Math.min(ra[0], rb[0]), rx1 = Math.max(ra[0], rb[0]);
    const rz0 = Math.min(ra[1], rb[1]), rz1 = Math.max(ra[1], rb[1]);
    const deadline = frameDeadline;
    let unfinished = false;
    shownVillages = [];
    if (hiddenByZoom('village')) return;
    for (let rx = rx0; rx <= rx1; rx++) for (let rz = rz0; rz <= rz1; rz++) {
      const k = rx + ',' + rz;
      if (!villageCache.has(k)) { ask(k, ['village', rx, rz], (rx + 0.5) * R, -(rz + 0.5) * R); continue; }
      const v = villageCache.get(k);
      if (!v || hiddenKinds.has('village_' + v.type)) continue;
      const [px, py] = toScreen(v.x + 0.5, v.z + 0.5);
      if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
      shownVillages.push({ v, px, py });
      stamp('h' + v.type + v.zombie, px, py, (x, y) => drawHouse(x, y, VILLAGE_COLOR[v.type], v.zombie));
    }
    if (unfinished) requestDraw();
  }

  // A small cluster of houses: a tall one at the back and a low one in
  // front, filled with the village type's color.
  // Map icons are drawn once into a small bitmap per kind and then copied,
  // which is much faster than drawing every icon's shapes each frame.
  const SPRITE = 48, sprites = new Map();
  function stamp(id, px, py, paint) {
    const d = window.devicePixelRatio || 1;
    let sp = sprites.get(id);
    if (!sp || sp.d !== d) {
      const c = document.createElement('canvas');
      c.width = c.height = Math.ceil(SPRITE * d);
      const g = c.getContext('2d');
      g.scale(d, d);
      const mapCtx = ctx;
      ctx = g;
      try { paint(SPRITE / 2, SPRITE / 2); } finally { ctx = mapCtx; }
      sp = { c, d };
      sprites.set(id, sp);
    }
    ctx.drawImage(sp.c, Math.round(px) - SPRITE / 2, Math.round(py) - SPRITE / 2, SPRITE, SPRITE);
  }

  function drawHouse(px, py, color, zombie) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.strokeStyle = zombie ? '#b3261e' : '#1b1d22';
    ctx.lineWidth = zombie ? 3 : 2;
    ctx.lineJoin = 'round';
    const house = (x, y, w, h, roof) => {
      ctx.beginPath();
      ctx.moveTo(x - w / 2 - 1, y - h + 1); ctx.lineTo(x, y - h - roof);
      ctx.lineTo(x + w / 2 + 1, y - h + 1); ctx.lineTo(x + w / 2, y - h + 1);
      ctx.lineTo(x + w / 2, y); ctx.lineTo(x - w / 2, y); ctx.lineTo(x - w / 2, y - h + 1);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.stroke(); ctx.fill();
    };
    house(-4, 5, 10, 11, 5);   // back house
    house(5, 8, 9, 7, 4);      // front house
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(4, 4, 3, 4);  // door
    ctx.fillRect(-6, -3, 3, 3); // window
    ctx.restore();
  }

  function villageNear(mx, my) {
    let best = null, bd = 14 * 14;
    for (const s of shownVillages) {
      const d = (s.px - mx) ** 2 + (s.py - my) ** 2;
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  // ------------------------------------------------------------ ruined portals
  // Placement regions are 40 x 40 Mineclonia chunks (640 x 640 nodes), with
  // one ruined portal in almost every region.
  let showPortals = true, portalFinder = null;
  const portalCache = new Map();
  let shownPortals = [];

  function drawPortals(w, h) {
    const P = window.MclPortals;
    const R = P.SPACING * 16;
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    const ra = P.regionOf(Math.floor(x0) - R, Math.floor(z1) + R);
    const rb = P.regionOf(Math.floor(x1) + R, Math.floor(z0) - R);
    const rx0 = Math.min(ra[0], rb[0]), rx1 = Math.max(ra[0], rb[0]);
    const rz0 = Math.min(ra[1], rb[1]), rz1 = Math.max(ra[1], rb[1]);
    const deadline = frameDeadline;
    let unfinished = false;
    shownPortals = [];
    if (hiddenByZoom('portal')) return;
    for (let rx = rx0; rx <= rx1; rx++) for (let rz = rz0; rz <= rz1; rz++) {
      const k = rx + ',' + rz;
      if (!portalCache.has(k)) { ask(k, ['portal', rx, rz], (rx + 0.5) * R, -(rz + 0.5) * R); continue; }
      const p = portalCache.get(k);
      if (!p) continue;
      const [px, py] = toScreen(p.x + 0.5, p.z + 0.5);
      if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
      shownPortals.push({ v: p, px, py });
      if (hiddenKinds.has('portal')) continue;
      stamp('p' + p.giant, px, py, (x, y) => drawPortal(x, y, p.giant));
    }
    if (unfinished) requestDraw();
  }

  // An obsidian frame with a purple middle; large portals are drawn bigger.
  function drawPortal(px, py, giant) {
    const hw = giant ? 7 : 5, hh = giant ? 10 : 8;
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(-hw - 2, -hh - 2, 2 * hw + 4, 2 * hh + 4);
    ctx.fillStyle = '#1e1530';
    ctx.fillRect(-hw - 1, -hh - 1, 2 * hw + 2, 2 * hh + 2);
    ctx.fillStyle = '#a45cf0';
    ctx.fillRect(-hw + 2, -hh + 2, 2 * hw - 4, 2 * hh - 4);
    ctx.restore();
  }

  function portalNear(mx, my) {
    let best = null, bd = 14 * 14;
    for (const s of shownPortals) {
      const d = (s.px - mx) ** 2 + (s.py - my) ** 2;
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  // ------------------------------------------------------------ nether
  // Fortresses and bastion remnants share 27 x 27-chunk regions, one of the
  // two in every region.  Shown only when the map shows the Nether.
  const NETHER_KIND = { fortress: 'Nether fortress', bastion: 'Bastion remnant', nether_portal: 'Ruined portal' };
  const NETHER_LABEL = { Nether: 'Nether Wastes', SoulsandValley: 'Soul Sand Valley', CrimsonForest: 'Crimson Forest',
    WarpedForest: 'Warped Forest', BasaltDelta: 'Basalt Deltas' };
  let showNether = true, netherFinder = null;
  const netherCache = new Map(), netherPortalCache = new Map();
  let shownNether = [];

  function drawNether(w, h) {
    const NE = window.MclNether;
    const R = NE.SPACING * 16;
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    const ra = NE.regionOf(Math.floor(x0) - R, Math.floor(z1) + R);
    const rb = NE.regionOf(Math.floor(x1) + R, Math.floor(z0) - R);
    const rx0 = Math.min(ra[0], rb[0]), rx1 = Math.max(ra[0], rb[0]);
    const rz0 = Math.min(ra[1], rb[1]), rz1 = Math.max(ra[1], rb[1]);
    const deadline = frameDeadline;
    let unfinished = false;
    shownNether = [];
    if (!hiddenByZoom('nether')) for (let rx = rx0; rx <= rx1; rx++) for (let rz = rz0; rz <= rz1; rz++) {
      const k = rx + ',' + rz;
      if (!netherCache.has(k)) { ask(k, ['nether', rx, rz], (rx + 0.5) * R, -(rz + 0.5) * R); continue; }
      const o = netherCache.get(k);
      if (!o) continue;
      const [px, py] = toScreen(o.x + 0.5, o.z + 0.5);
      if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
      shownNether.push({ v: o, px, py });
      if (hiddenKinds.has(o.kind)) continue;
      stamp('n' + o.kind, px, py, (x, y) => drawNetherIcon(x, y, o.kind));
    }
    // Ruined portals: one in every 40 x 40-chunk region.
    const PR = window.MclPortals.SPACING * 16;
    const pa = NE.portalRegionOf(Math.floor(x0) - PR, Math.floor(z1) + PR);
    const pb = NE.portalRegionOf(Math.floor(x1) + PR, Math.floor(z0) - PR);
    if (!hiddenByZoom('nether_portal')) for (let rx = Math.min(pa[0], pb[0]); rx <= Math.max(pa[0], pb[0]); rx++) {
      for (let rz = Math.min(pa[1], pb[1]); rz <= Math.max(pa[1], pb[1]); rz++) {
        const k = rx + ',' + rz;
        if (!netherPortalCache.has(k)) { ask(k, ['netherPortal', rx, rz], (rx + 0.5) * PR, -(rz + 0.5) * PR); continue; }
        const o = netherPortalCache.get(k);
        const [px, py] = toScreen(o.x + 0.5, o.z + 0.5);
        if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
        shownNether.push({ v: o, px, py });
        if (hiddenKinds.has('nether_portal')) continue;
        stamp('p' + o.giant, px, py, (x, y) => drawPortal(x, y, o.giant));
      }
    }
    if (unfinished) requestDraw();
  }

  // Fortress: a nether brick tower with battlements.  Bastion: a blackstone
  // block with a band of gold.
  function drawNetherIcon(px, py, kind) {
    if (kind === 'nether_portal') { drawPortal(px, py, false); return; }
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    if (kind === 'fortress') {
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(-9, -9, 18, 18);
      ctx.fillStyle = '#3b1416';
      ctx.fillRect(-8, -5, 16, 13);
      for (const bx of [-8, -2, 4]) ctx.fillRect(bx, -8, 4, 4);
      ctx.fillStyle = '#6e2a2a';
      ctx.fillRect(-6, -3, 5, 3); ctx.fillRect(1, -3, 5, 3); ctx.fillRect(-3, 2, 6, 3);
      ctx.fillStyle = '#0d0405';
      ctx.fillRect(-2, 4, 4, 4);
    } else {
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(-9, -9, 18, 18);
      ctx.fillStyle = '#2a262d';
      ctx.fillRect(-8, -8, 16, 16);
      ctx.fillStyle = '#e8b93a';
      ctx.fillRect(-8, -1, 16, 3);
      ctx.fillStyle = '#4a4450';
      ctx.fillRect(-6, -6, 4, 3); ctx.fillRect(2, 4, 4, 3);
    }
    ctx.restore();
  }

  function netherNear(mx, my) {
    let best = null, bd = 14 * 14;
    for (const s of shownNether) {
      const d = (s.px - mx) ** 2 + (s.py - my) ** 2;
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  // ------------------------------------------------------------ the End
  // Fixed features from Mineclonia's End code: the exit portal, the
  // obsidian platform players arrive on, ten obsidian pillars and the twenty
  // places End gateways appear (one more each time the dragon is killed).
  let showEnd = true;
  let shownEnd = [];
  const END_LABEL = { end_portal: 'Exit portal', end_platform: 'Arrival platform', end_spike: 'Obsidian pillar',
    end_gateway: 'End gateway spot' };
  const endTitle = (o) => END_LABEL[o.kind] + (o.n ? ' ' + o.n : '');

  function drawEnd(w, h) {
    shownEnd = [];
    // Draw the many gateways first so the portal and pillars sit on top.
    const list = window.MclEnd.FEATURES.slice().sort((a, b) => (a.kind === 'end_gateway' ? 0 : 1) - (b.kind === 'end_gateway' ? 0 : 1));
    for (const o of list) {
      const [px, py] = toScreen(o.x + 0.5, o.z + 0.5);
      if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
      shownEnd.push({ v: o, px, py });
      if (hiddenKinds.has(o.kind)) continue;
      drawEndIcon(px, py, o.kind);
    }
  }

  function drawEndIcon(px, py, kind) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.fillStyle = '#f2f2f2';
    if (kind === 'end_portal') {
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0c0a1c'; ctx.beginPath(); ctx.arc(0, 0, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#9fe8d0';
      for (const [sx, sy] of [[-3, -3], [2, -1], [-1, 3], [3, 3], [0, -5]]) ctx.fillRect(sx, sy, 1.5, 1.5);
    } else if (kind === 'end_platform') {
      ctx.fillRect(-7, -7, 14, 14);
      ctx.fillStyle = '#1d1430'; ctx.fillRect(-6, -6, 12, 12);
      ctx.fillStyle = '#3d2c63'; ctx.fillRect(-4, -4, 3, 3); ctx.fillRect(1, 1, 3, 3);
    } else if (kind === 'end_spike') {
      ctx.fillRect(-4, -9, 8, 18);
      ctx.fillStyle = '#1d1430'; ctx.fillRect(-3, -8, 6, 16);
      ctx.fillStyle = '#f07ad8'; ctx.fillRect(-1.5, -7, 3, 3);
    } else {
      ctx.fillRect(-4, -4, 8, 8);
      ctx.fillStyle = '#0c0a1c'; ctx.fillRect(-3, -3, 6, 6);
      ctx.fillStyle = '#9fe8d0'; ctx.fillRect(-1, -1, 2, 2);
    }
    ctx.restore();
  }

  function endNear(mx, my) {
    let best = null, bd = 12 * 12;
    for (const s of shownEnd) {
      const d = (s.px - mx) ** 2 + (s.py - my) ** 2;
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  // ------------------------------------------------------------ temples
  // Desert pyramids, jungle temples, igloos and swamp huts: each has its own
  // 32 x 32-chunk (512 x 512-node) regions, with at most one per region.
  const TEMPLE_LABEL = { desert_pyramid: 'Desert pyramid', jungle_temple: 'Jungle temple',
    igloo: 'Igloo', swamp_hut: 'Swamp hut' };
  let showTemples = true, templeFinder = null;
  const templeCache = new Map();
  let shownTemples = [];

  function drawTemples(w, h) {
    const T = window.MclTemples;
    const R = T.SPACING * 16;
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    const ra = T.regionOf(Math.floor(x0) - R, Math.floor(z1) + R);
    const rb = T.regionOf(Math.floor(x1) + R, Math.floor(z0) - R);
    const rx0 = Math.min(ra[0], rb[0]), rx1 = Math.max(ra[0], rb[0]);
    const rz0 = Math.min(ra[1], rb[1]), rz1 = Math.max(ra[1], rb[1]);
    const deadline = frameDeadline;
    let unfinished = false;
    shownTemples = [];
    for (let rx = rx0; rx <= rx1; rx++) for (let rz = rz0; rz <= rz1; rz++) {
      for (const kind of T.KINDS) {
        if (hiddenKinds.has(kind) || hiddenByZoom(kind)) continue;
        const k = kind + ',' + rx + ',' + rz;
        if (!templeCache.has(k)) { ask(k, ['temple', kind, rx, rz], (rx + 0.5) * R, -(rz + 0.5) * R); continue; }
        const t = templeCache.get(k);
        if (!t) continue;
        const [px, py] = toScreen(t.x + 0.5, t.z + 0.5);
        if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
        shownTemples.push({ v: t, px, py });
        stamp('t' + kind, px, py, (x, y) => drawTemple(x, y, kind));
      }
    }
    if (unfinished) requestDraw();
  }

  function drawTemple(px, py, kind) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1b1d22';
    ctx.beginPath();
    if (kind === 'desert_pyramid') {        // a sandstone pyramid
      ctx.moveTo(0, -9); ctx.lineTo(10, 7); ctx.lineTo(-10, 7); ctx.closePath();
      ctx.fillStyle = '#f0d9a0';
    } else if (kind === 'jungle_temple') {  // a stepped, mossy temple
      ctx.moveTo(-10, 7); ctx.lineTo(-10, 2); ctx.lineTo(-7, 2); ctx.lineTo(-7, -3);
      ctx.lineTo(-4, -3); ctx.lineTo(-4, -8); ctx.lineTo(4, -8); ctx.lineTo(4, -3);
      ctx.lineTo(7, -3); ctx.lineTo(7, 2); ctx.lineTo(10, 2); ctx.lineTo(10, 7); ctx.closePath();
      ctx.fillStyle = '#6f9a4a';
    } else if (kind === 'igloo') {          // a snow dome
      ctx.moveTo(-10, 6); ctx.arc(0, 6, 10, Math.PI, 0); ctx.closePath();
      ctx.fillStyle = '#ffffff';
    } else {                                // a hut on stilts
      ctx.moveTo(-9, -2); ctx.lineTo(0, -10); ctx.lineTo(9, -2); ctx.lineTo(7, -2);
      ctx.lineTo(7, 4); ctx.lineTo(-7, 4); ctx.lineTo(-7, -2); ctx.closePath();
      ctx.fillStyle = '#8a6a45';
    }
    ctx.stroke(); ctx.fill();
    ctx.fillStyle = '#1b1d22';
    if (kind === 'igloo') ctx.fillRect(-2, 1, 4, 5);
    else if (kind === 'swamp_hut') { ctx.fillRect(-6, 4, 2, 5); ctx.fillRect(4, 4, 2, 5); ctx.fillRect(-1, -1, 3, 5); }
    else if (kind === 'desert_pyramid') ctx.fillRect(-2, 2, 4, 5);
    else ctx.fillRect(-2, -6, 4, 4);
    ctx.restore();
  }

  function templeNear(mx, my) {
    let best = null, bd = 14 * 14;
    for (const s of shownTemples) {
      const d = (s.px - mx) ** 2 + (s.py - my) ** 2;
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  // ------------------------------------------------------------ ocean
  // Shipwrecks (24-chunk regions), ocean ruins (20) and monuments (32).
  let showOcean = true, oceanFinder = null;
  const oceanCache = new Map();
  let shownOcean = [];

  function drawOcean(w, h) {
    const O = window.MclOcean;
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    const deadline = frameDeadline;
    let unfinished = false;
    shownOcean = [];
    for (const [kind, L] of Object.entries(O.LAYERS)) {
      if (hiddenKinds.has(kind) || hiddenByZoom(kind)) continue;
      const R = L.spacing * 16;
      const ra = O.regionOf(L.spacing, Math.floor(x0) - R, Math.floor(z1) + R);
      const rb = O.regionOf(L.spacing, Math.floor(x1) + R, Math.floor(z0) - R);
      const rx0 = Math.min(ra[0], rb[0]), rx1 = Math.max(ra[0], rb[0]);
      const rz0 = Math.min(ra[1], rb[1]), rz1 = Math.max(ra[1], rb[1]);
      for (let rx = rx0; rx <= rx1; rx++) for (let rz = rz0; rz <= rz1; rz++) {
        const k = kind + ',' + rx + ',' + rz;
        if (!oceanCache.has(k)) { ask(k, ['ocean', L.fn, rx, rz], (rx + 0.5) * R, -(rz + 0.5) * R); continue; }
        const o = oceanCache.get(k);
        if (!o) continue;
        const [px, py] = toScreen(o.x + 0.5, o.z + 0.5);
        if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
        shownOcean.push({ v: o, px, py });
        stamp('o' + o.kind + o.temp, px, py, (x, y) => drawOceanIcon(x, y, o));
      }
    }
    if (unfinished) requestDraw();
  }

  function drawOceanIcon(px, py, o) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1b1d22';
    if (o.kind === 'shipwreck') {         // a boat with a broken mast
      ctx.beginPath();
      ctx.moveTo(-10, 1); ctx.lineTo(10, 1); ctx.lineTo(6, 7); ctx.lineTo(-6, 7); ctx.closePath();
      ctx.fillStyle = '#9b6b3c'; ctx.stroke(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-1, 1); ctx.lineTo(-1, -9); ctx.lineTo(6, -3); ctx.lineTo(-1, -3);
      ctx.fillStyle = '#e8e0cc'; ctx.stroke(); ctx.fill();
    } else if (o.kind === 'ocean_ruin') { // broken stone pillars
      ctx.fillStyle = o.temp === 'warm' ? '#e3cf96' : '#a9b0b4';
      for (const [x, y, hh] of [[-8, -2, 9], [-2, -7, 14], [4, 0, 7]]) {
        ctx.beginPath(); ctx.rect(x, y, 5, hh); ctx.stroke(); ctx.fill();
      }
    } else {                              // a monument: prismarine with a dome
      ctx.beginPath();
      ctx.moveTo(-11, 8); ctx.lineTo(-11, 0); ctx.lineTo(-5, 0); ctx.lineTo(-5, -5);
      ctx.lineTo(5, -5); ctx.lineTo(5, 0); ctx.lineTo(11, 0); ctx.lineTo(11, 8); ctx.closePath();
      ctx.fillStyle = '#4fb3a4'; ctx.stroke(); ctx.fill();
      ctx.beginPath(); ctx.rect(-2, -10, 4, 5); ctx.fillStyle = '#2f7f74'; ctx.stroke(); ctx.fill();
      ctx.fillStyle = '#1b1d22'; ctx.fillRect(-2, 3, 4, 5);
    }
    ctx.restore();
  }

  function oceanNear(mx, my) {
    let best = null, bd = 14 * 14;
    for (const s of shownOcean) {
      const d = (s.px - mx) ** 2 + (s.py - my) ** 2;
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  // ------------------------------------------------------------ outposts & more
  // Pillager outposts (32-chunk regions), trail ruins (34), trial chambers (34).
  let showLand = true, landFinder = null;
  const landCache = new Map();
  let shownLand = [];

  function drawLand(w, h) {
    const O = window.MclLandmarks;
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    const deadline = frameDeadline;
    let unfinished = false;
    shownLand = [];
    for (const [kind, L] of Object.entries(O.LAYERS)) {
      if (hiddenKinds.has(kind) || hiddenByZoom(kind)) continue;
      const R = L.spacing * 16;
      const ra = O.regionOf(L.spacing, Math.floor(x0) - R, Math.floor(z1) + R);
      const rb = O.regionOf(L.spacing, Math.floor(x1) + R, Math.floor(z0) - R);
      const rx0 = Math.min(ra[0], rb[0]), rx1 = Math.max(ra[0], rb[0]);
      const rz0 = Math.min(ra[1], rb[1]), rz1 = Math.max(ra[1], rb[1]);
      for (let rx = rx0; rx <= rx1; rx++) for (let rz = rz0; rz <= rz1; rz++) {
        const k = kind + ',' + rx + ',' + rz;
        if (!landCache.has(k)) { ask(k, ['land', L.fn, rx, rz], (rx + 0.5) * R, -(rz + 0.5) * R); continue; }
        const got = landCache.get(k);
        if (!got) continue;
        for (const o of Array.isArray(got) ? got : [got]) {
          const [px, py] = toScreen(o.x + 0.5, o.z + 0.5);
          if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
          shownLand.push({ v: o, px, py });
          stamp('l' + o.kind, px, py, (x, y) => drawLandIcon(x, y, o.kind));
        }
      }
    }
    if (unfinished) requestDraw();
  }

  function drawLandIcon(px, py, kind) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1b1d22';
    ctx.beginPath();
    if (kind === 'treasure') {             // a treasure chest
      ctx.rect(-8, -6, 16, 12);
      ctx.fillStyle = '#b07a32'; ctx.stroke(); ctx.fill();
      ctx.fillStyle = '#1b1d22'; ctx.fillRect(-8, -2, 16, 2);
      ctx.fillStyle = '#f4d35e'; ctx.fillRect(-2, -3, 4, 4);
    } else if (kind === 'mineshaft') {     // a pickaxe
      ctx.lineWidth = 4; ctx.strokeStyle = '#1b1d22';
      ctx.moveTo(-7, 8); ctx.lineTo(5, -4); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = '#8a6a45';
      ctx.beginPath(); ctx.moveTo(-7, 8); ctx.lineTo(5, -4); ctx.stroke();
      ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = '#1b1d22';
      ctx.moveTo(-3, -9); ctx.quadraticCurveTo(7, -7, 9, 3); ctx.lineTo(7, 3);
      ctx.quadraticCurveTo(5, -4, -3, -7); ctx.closePath();
      ctx.fillStyle = '#c0c4c8'; ctx.stroke(); ctx.fill();
    } else if (kind === 'mansion') {       // a wide dark-oak mansion
      ctx.moveTo(-12, 8); ctx.lineTo(-12, -3); ctx.lineTo(-6, -9); ctx.lineTo(0, -3);
      ctx.lineTo(6, -9); ctx.lineTo(12, -3); ctx.lineTo(12, 8); ctx.closePath();
      ctx.fillStyle = '#5a3d27'; ctx.stroke(); ctx.fill();
      ctx.fillStyle = '#e8e0cc';
      for (const wx of [-9, -4, 3, 8]) ctx.fillRect(wx, -1, 2, 3);
      ctx.fillStyle = '#1b1d22'; ctx.fillRect(-1, 3, 3, 5);
    } else if (kind === 'outpost') {       // a dark watchtower with battlements
      ctx.moveTo(-5, 9); ctx.lineTo(-5, -5); ctx.lineTo(-7, -5); ctx.lineTo(-7, -10);
      ctx.lineTo(-4, -10); ctx.lineTo(-4, -8); ctx.lineTo(-1, -8); ctx.lineTo(-1, -10);
      ctx.lineTo(1, -10); ctx.lineTo(1, -8); ctx.lineTo(4, -8); ctx.lineTo(4, -10);
      ctx.lineTo(7, -10); ctx.lineTo(7, -5); ctx.lineTo(5, -5); ctx.lineTo(5, 9); ctx.closePath();
      ctx.fillStyle = '#6b5a4a'; ctx.stroke(); ctx.fill();
      ctx.fillStyle = '#e8e0cc'; ctx.fillRect(-2, -3, 4, 6); // banner
    } else if (kind === 'trail_ruins') {   // a decorated pot
      ctx.moveTo(-3, -9); ctx.lineTo(3, -9); ctx.lineTo(3, -6);
      ctx.bezierCurveTo(10, -4, 10, 8, 4, 9); ctx.lineTo(-4, 9);
      ctx.bezierCurveTo(-10, 8, -10, -4, -3, -6); ctx.closePath();
      ctx.fillStyle = '#c9744a'; ctx.stroke(); ctx.fill();
      ctx.fillStyle = '#1b1d22'; ctx.fillRect(-5, 1, 10, 2);
    } else {                               // a copper and tuff block
      ctx.rect(-9, -9, 18, 18);
      ctx.fillStyle = '#c87a4f'; ctx.stroke(); ctx.fill();
      ctx.fillStyle = '#5b6a62'; ctx.fillRect(-5, -5, 10, 10);
      ctx.fillStyle = '#c87a4f'; ctx.fillRect(-1, -5, 2, 10); ctx.fillRect(-5, -1, 10, 2);
    }
    ctx.restore();
  }

  function landNear(mx, my) {
    let best = null, bd = 14 * 14;
    for (const s of shownLand) {
      const d = (s.px - mx) ** 2 + (s.py - my) ** 2;
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  // ------------------------------------------------------------ spawn
  // Luanti's spawn search (see spawn.js): a star on the suitable spot
  // nearest 0,0 and a dashed square for the area new players land in.
  let showSpawn = true, spawnInfo = null, spawnScreen = null, spawnTimer = 0;

  function findSpawnLater() {
    clearTimeout(spawnTimer);
    spawnInfo = null;
    const gen = generation;
    spawnTimer = setTimeout(() => {
      if (gen !== generation) return;
      const r = new window.LuantiSpawn.Spawn(seed32).find(300);
      // Square holding 95% of the simulated spawns.
      const d = r.hits.map(([x, z]) => Math.max(Math.abs(x), Math.abs(z))).sort((a, b) => a - b);
      spawnInfo = { nearest: r.nearest, reach: d.length ? d[Math.floor(d.length * 0.95)] : 0 };
      requestDraw();
    }, 50);
  }

  function drawStar(px, py) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 4.5 : 10, a = -Math.PI / 2 + i * Math.PI / 5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineWidth = 2; ctx.strokeStyle = '#1b1d22'; ctx.fillStyle = '#ffd23f';
    ctx.stroke(); ctx.fill();
    ctx.restore();
  }

  function drawSpawn(w, h) {
    spawnScreen = null;
    if (!spawnInfo || hiddenKinds.has('spawn') || !spawnInfo.nearest) return;
    const R = spawnInfo.reach;
    const [ax, ay] = toScreen(-R, R + 1), [bx, by] = toScreen(R + 1, -R);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,210,63,0.9)';
    ctx.strokeRect(Math.round(ax) + 0.5, Math.round(ay) + 0.5, Math.round(bx - ax), Math.round(by - ay));
    ctx.restore();
    const o = spawnInfo.nearest;
    const [px, py] = toScreen(o.x + 0.5, o.z + 0.5);
    spawnScreen = [px, py];
    drawStar(px, py);
  }

  function spawnNear(mx, my) {
    return spawnScreen && (spawnScreen[0] - mx) ** 2 + (spawnScreen[1] - my) ** 2 < 14 * 14;
  }

  document.getElementById('show-spawn').addEventListener('change', (e) => {
    showSpawn = e.target.checked; requestDraw();
  });

  // ------------------------------------------------------------ selection
  // Clicking an icon selects it: the icon is drawn larger with a ring, and
  // a card on the map explains what it is and how exact its position is.
  let selected = null; // { group, v }
  const info = document.getElementById('info');

  function itemAt(mx, my) {
    const pick = (group, v) => (v ? { group, v } : null);
    const wp = showWp && waypointNear(mx, my);
    if (wp) return { group: 'waypoint', v: wp };
    if (dim === 'nether') return pick('nether', netherNear(mx, my));
    if (dim === 'end') return pick('end', endNear(mx, my));
    return pick('village', villageNear(mx, my)) ||
      (spawnNear(mx, my) ? { group: 'spawn', v: spawnInfo.nearest } : null) ||
      pick('strong', strongNear(mx, my)) || pick('land', landNear(mx, my)) ||
      pick('ocean', oceanNear(mx, my)) || pick('temple', templeNear(mx, my)) ||
      pick('portal', portalNear(mx, my));
  }

  function drawIcon(sel, px, py) {
    const v = sel.v;
    if (sel.group === 'village') drawHouse(px, py, VILLAGE_COLOR[v.type], v.zombie);
    else if (sel.group === 'spawn') drawStar(px, py);
    else if (sel.group === 'strong') drawEye(px, py);
    else if (sel.group === 'land') drawLandIcon(px, py, v.kind);
    else if (sel.group === 'ocean') drawOceanIcon(px, py, v);
    else if (sel.group === 'temple') drawTemple(px, py, v.kind);
    else if (sel.group === 'end') drawEndIcon(px, py, v.kind);
    else if (sel.group === 'nether') { if (v.kind === 'nether_portal') drawPortal(px, py, v.giant); else drawNetherIcon(px, py, v.kind); }
    else drawPortal(px, py, v.giant);
  }

  function drawSelection() {
    if (!selected) return;
    const [px, py] = toScreen(selected.v.x + 0.5, selected.v.z + 0.5);
    if (selected.group === 'spot' || selected.group === 'waypoint') {
      drawPin(px, py, selected.group === 'spot' ? SPOT_COLOR : WP_COLOR, 1.35, true);
      return;
    }
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,22,26,0.55)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.scale(1.5, 1.5);
    drawIcon(selected, 0, 0);
    ctx.restore();
  }

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // What each structure is and why players look for it (checked against
  // Mineclonia's loot tables and mob lists in mcl_levelgen), and the
  // article that describes it in more depth.
  const WIKI = 'https://minecraft.wiki/w/';
  // The project's GitHub page (code, bug reports and ideas).
  const PROJECT_URL = 'https://github.com/buddyhollyy/Antichunk';
  // GitHub's mark, from Primer Octicons 19.42.0 (mark-github-16, MIT license).
  const GITHUB_MARK = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.030 16 3.610 12.406 0 7.984 0 3.563 0 0 3.610 0 8.031a7.880 7.880 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.250c-.219.094-.5.156-.75.156-1.031 0-1.640-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.250.86.313.452.640.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/></svg>';
  const ABOUT = {
    spawn: ['Where new players first appear in the world, and where players without a bed respawn after dying.', 'Spawn'],
    village: ['A settlement of villagers. Trade with them for emeralds, enchanted books and tools, and look for chests with useful loot. ' +
      'Abandoned villages are full of zombie villagers instead.', 'Village'],
    portal: ['A broken Nether portal. It has a chest with gold tools, gold armor, golden apples and flint and steel, and the ' +
      'obsidian can be repaired into a working portal to the Nether.', 'Ruined_Portal'],
    desert_pyramid: ['A sandstone temple in the desert. Four chests under the floor can hold diamonds, emeralds, golden apples and ' +
      'horse armor, but a pressure plate there sets off TNT.', 'Desert_Pyramid'],
    jungle_temple: ['A mossy stone temple hidden in the jungle, with dispenser traps and a hidden lever puzzle. Its two chests ' +
      'can hold diamonds and enchanted golden apples.', 'Jungle_Pyramid'],
    igloo: ['A snow hut in snowy biomes. Some hide a basement with a chest that holds golden apples.', 'Igloo'],
    swamp_hut: ['A wooden hut on stilts in the swamp, home to a witch and a black cat.', 'Swamp_Hut'],
    shipwreck: ['A sunken or wrecked ship. Its chests can hold emeralds, diamonds and maps that lead to buried treasure.', 'Shipwreck'],
    ocean_ruin: ['Underwater stone ruins guarded by drowned. Chests can hold treasure maps and enchanted golden apples.', 'Ocean_Ruins'],
    monument: ['A large underwater temple guarded by guardians and elder guardians. It holds wet sponges and a hidden room of gold blocks.',
      'Ocean_Monument'],
    treasure: ['A chest buried under sand, found with a map from a shipwreck or ocean ruin. It always holds a heart of the sea, ' +
      'used to make a conduit.', 'Buried_Treasure'],
    mineshaft: ['Abandoned mine tunnels with rails, cobwebs and cave spider spawners. Minecarts with chests can hold diamonds, ' +
      'golden apples and enchanted books.', 'Mineshaft'],
    mansion: ['A huge dark oak house in the dark forest, home to vindicators and evokers. Evokers drop totems of undying.',
      'Woodland_Mansion'],
    outpost: ['A watchtower full of pillagers, with a chest of loot at the top. Some have a caged iron golem nearby.', 'Pillager_Outpost'],
    trail_ruins: ['Buried remains of an old settlement. Brush its suspicious gravel to dig up pottery sherds and other finds.', 'Trail_Ruins'],
    trial_chambers: ['An underground complex of copper and tuff with trial spawners and breezes. Beat the trials to earn trial keys, ' +
      'which open vaults full of loot.', 'Trial_Chambers'],
    end_portal: ['The portal back to the overworld, in the middle of the main island. The ender dragon guards it; it opens ' +
      'once the dragon is killed.', 'Exit_portal'],
    end_platform: ['The obsidian platform where players arrive from a stronghold\'s End portal.', 'The_End'],
    end_spike: ['A tall obsidian pillar with an End crystal on top that heals the dragon. Some crystals are protected by iron bars.',
      'End_spike'],
    end_gateway: ['A small portal that appears after the dragon is killed. Throw an ender pearl into it to reach the outer islands.',
      'The_End'],
    nether_portal: ['A broken Nether portal on the Nether side. Its chest can hold gold tools, ' +
      'gold armor, golden apples and flint and steel, and the obsidian can be repaired into a working portal.', 'Ruined_Portal'],
    fortress: ['A huge castle of nether brick bridges and corridors. It is the only place to find blazes, whose rods are needed for ' +
      'brewing and eyes of ender, and wither skeletons, whose skulls summon the Wither. Its corridors also grow nether wart.',
    'Nether_Fortress'],
    bastion: ['A ruined blackstone castle full of piglins and piglin brutes. Its chests can hold gold, netherite and ' +
      'enchanted golden apples.', 'Bastion_Remnant'],
    stronghold: ['An underground fortress with libraries and the End portal room. Fill the portal frame with eyes of ender to ' +
      'travel to the End.', 'Stronghold'],
  };
  function aboutKey(sel) {
    if (sel.group === 'spawn' || sel.group === 'village' || sel.group === 'portal') return sel.group;
    if (sel.group === 'strong') return 'stronghold';
    return sel.v.kind;
  }

  // Title, facts, and a note on accuracy for each kind of selection.
  function describe(sel) {
    const v = sel.v;
    const exact = 'This position is exact: Mineclonia\'s /locate reports the same X and Z.';
    const yNote = 'Y comes from Mineclonia\'s own estimate of the terrain, which can be a few blocks off from the real ground.';
    // far: how far Mineclonia lets the structure's pieces reach from its
    // start (the limits in stronghold.lua, mineshaft.lua, trail_ruins.lua
    // and trial_chambers.lua), which bounds how far /locate's center can be.
    const startNote = (what, far) => 'The icon marks the ' + what + '. The rest of the structure is built outward from there, ' +
      'so /locate reports its center, which ' + (far ? 'can be up to about ' + far + ' blocks from the icon, though usually closer.'
        : 'can be some way from the icon.');
    let title, facts = [], notes = [], cmd = null;
    const loc = (id) => { cmd = '/locate structure ' + id; return '<code>' + esc(cmd) + '</code>'; };
    const y = v.centerY ? v.centerY() : v.y;
    const pos = 'X ' + v.x + (y === null || y === undefined ? '' : ', Y ' + y) + ', Z ' + v.z;
    if (sel.from) facts.push(['Distance', fmt(sel.from.d) + ' blocks from X ' + sel.from.x + ', Z ' + sel.from.z]);
    if (sel.group === 'spot' || sel.group === 'waypoint') {
      title = sel.group === 'spot' ? 'Map location' : v.name;
      facts.push(['Position', 'X ' + v.x + ', Z ' + v.z]);
      const at = sampleAt(v.x, v.z);
      sel.waitTile = !at;
      if (at) {
        const b = at.t.biome[at.idx], ty = at.t.surface[at.idx], near = at.st === 1 ? 'Y ' : 'Y ≈ ';
        if (dim === 'overworld') {
          facts.push(['Top block', near + ty + (at.t.water[at.idx] ? ' (under water)' : '')]);
          facts.push(['Biome', biomeLabel(window.LuantiBiomes.BIOMES[b].name)]);
          facts.push(['Slime chunk', slimeText(v.x, v.z)]);
        } else if (dim === 'nether') {
          facts.push(['Biome', NETHER_LABEL[window.LuantiBiomes.BIOMES[b].name]]);
        } else {
          facts.push(['Top block', ty === -32768 ? 'none (void)' : near + ty]);
          facts.push(['Area', ['main island area', 'inner ring of islands', 'outer islands'][b]]);
        }
      } else {
        facts.push(['Biome', 'loading…']);
      }
    } else if (sel.group === 'spawn') {
      title = 'Spawn point';
      facts.push(['Nearest suitable spot', 'X ' + v.x + ', Y ' + v.y + ', Z ' + v.z]);
      facts.push(['Spawn area (dashed square)', 'within ' + spawnInfo.reach + ' blocks of 0,0']);
      notes.push('In v7 worlds Mineclonia lets Luanti choose where new players appear. Luanti tries random spots in a square ' +
        'around 0,0 that grows a little with each try, and uses the first spot that is dry land, not in a river and no higher than Y 17.');
      notes.push('Those random numbers are not tied to the seed, so each new player can appear somewhere different. ' +
        'The star is the suitable spot nearest 0,0. The dashed square holds about 95% of 300 test runs of Luanti\'s search: ' +
        'new players almost always appear inside it.');
      notes.push('A server can also set a fixed spawn with the <code>static_spawnpoint</code> setting, which this map cannot know about.');
    } else if (sel.group === 'village') {
      title = (v.zombie ? 'Abandoned ' : '') + VILLAGE_LABEL[v.type] + ' village';
      facts.push(['Position', 'X ' + v.x + ', Z ' + v.z], ['Biome', biomeLabel(v.biome)]);
      notes.push('The icon marks the village\'s starting point. /locate reports the center of all its buildings, which is usually only a few blocks away.');
      notes.push('Find it in game with ' + loc('mcl_villages:village_' + v.type) + '.');
    } else if (sel.group === 'portal') {
      title = (v.giant ? 'Large ruined portal' : 'Ruined portal') + (v.kind === 'standard' ? '' : ' (' + v.kind + ')');
      facts.push(['Position', pos], ['Biome', biomeLabel(v.biome)]);
      if (v.placement === 'underground' || v.placement === 'in_mountain') facts.push(['Placement', 'buried in the ground']);
      notes.push(exact, yNote, 'Find it in game with ' + loc(v.id) + '.');
    } else if (sel.group === 'temple') {
      title = TEMPLE_LABEL[v.kind];
      facts.push(['Position', pos]);
      if (v.kind === 'igloo') facts.push(['Basement', v.basement ? 'yes' : 'no']);
      notes.push(exact, yNote, 'Find it in game with ' + loc(v.id) + '.');
    } else if (sel.group === 'ocean') {
      title = v.kind === 'shipwreck' ? 'Shipwreck' : v.kind === 'monument' ? 'Ocean monument'
        : (v.large ? 'Large ' : '') + v.temp + ' ocean ruin';
      title = title[0].toUpperCase() + title.slice(1);
      facts.push(['Position', pos]);
      if (v.kind === 'ocean_ruin' && v.count > 1) facts.push(['Group', v.count + ' ruins']);
      notes.push(exact, yNote, 'Find it in game with ' + loc(v.id) + '.');
    } else if (sel.group === 'strong') {
      title = 'Stronghold';
      facts.push(['Starting chunk', pos], ['Ring', v.ring + ' of 8']);
      notes.push(startNote('chunk the stronghold starts in', 112), 'Find it in game with ' + loc(v.id) + '.');
    } else if (sel.group === 'end') {
      title = endTitle(v);
      facts.push(['Position', pos]);
      if (v.kind === 'end_spike') {
        notes.push('Pillars stand in a circle 43 blocks from the exit portal. Their exact spot is rounded here, and each pillar\'s ' +
          'width and height are random, so no Y is given.');
      } else if (v.kind === 'end_gateway') {
        notes.push('This spot stays empty until the dragon has been killed ' + v.n + (v.n === 1 ? ' time' : ' times') + ': each ' +
          'kill adds the next gateway in this ring. Where a gateway leads (1,024 to 1,167 blocks out) is chosen at random ' +
          'when it is first used, so the map cannot show it.');
      } else {
        notes.push('This position is fixed: it is the same in every Mineclonia world.');
      }
    } else if (sel.group === 'nether') {
      title = v.giant ? 'Large ruined portal' : NETHER_KIND[v.kind];
      if (v.kind === 'nether_portal') {
        facts.push(['Position', pos]);
      } else if (v.kind === 'fortress') {
        facts.push(['Starting chunk', 'X ' + v.x + ', Z ' + v.z], ['Height', 'Y ' + v.yMin + ' to ' + v.yMax]);
      } else {
        facts.push(['Starting room', pos]);
      }
      facts.push(['Biome', NETHER_LABEL[Object.keys(window.MclNether.TARGET).find((k) => window.MclNether.TARGET[k] === v.biome)] || v.biome]);
      if (v.kind === 'nether_portal') {
        notes.push(exact, 'Y is exact too: in v7 worlds Mineclonia treats the whole Nether as solid rock when it places these, ' +
          'so the portal sits at the height its random numbers pick. It can end up inside netherrack or out in a cave.');
      } else if (v.kind === 'fortress') {
        notes.push(startNote('chunk the fortress starts in', 112) + ' The whole fortress is then moved up or down so it sits between the heights shown.');
      } else {
        notes.push(startNote('center of the starting room', 80));
      }
      notes.push('Find it in game with ' + loc(v.id) + ', standing in the Nether.');
    } else {
      const names = { treasure: 'Buried treasure', mineshaft: v.mesa ? 'Mesa mineshaft' : 'Mineshaft',
        mansion: 'Woodland mansion', outpost: 'Pillager outpost', trail_ruins: 'Trail ruins', trial_chambers: 'Trial chambers' };
      title = names[v.kind];
      facts.push(['Position', pos]);
      if (v.kind === 'outpost' || v.kind === 'treasure') notes.push(exact, yNote);
      else if (v.kind === 'mansion') notes.push(startNote('point the mansion is laid out around') + ' How far depends on the mansion\'s room layout, which the map does not work out.');
      else if (v.kind === 'mineshaft') notes.push(startNote('chunk the mineshaft starts in', 80) + ' The tunnels\' depth is not modeled, so no Y is given.');
      else notes.push(startNote('center of the starting room', v.kind === 'trial_chambers' ? 116 : 80));
      if (v.kind === 'trial_chambers') notes.push('Trial chambers are deep underground.');
      notes.push('Find it in game with ' + loc(v.id) + '.');
    }
    // Luanti's /teleport X,Y,Z (builtin/game/chat.lua) needs the teleport
    // privilege.  Y is the ground (or water surface) above the spot, from
    // Mineclonia's terrain model, so the player lands on top, not inside.
    // The Nether has no ground model, so no teleport is offered there.
    const tp = dim !== 'overworld' ? null : '/teleport ' + v.x + ',' + world.model.columnHeight(v.x, v.z, true) + ',' + v.z;
    // Where a Nether portal built on this spot would lead.
    const other = portalTarget(v.x, v.z);
    if (other) {
      facts.push([dim === 'overworld' ? 'Portal to Nether' : 'Portal to overworld', 'X ' + other.x + ', Z ' + other.z]);
      notes.push('A Nether portal built here leads to about X ' + other.x + ', Z ' + other.z + (dim === 'overworld'
        ? ' in the Nether (X and Z divided by 8). Mineclonia uses a portal already within 16 blocks of that spot if there is one, '
        : ' in the overworld (X and Z times 8). Mineclonia uses a portal already within 128 blocks of that spot if there is one, ') +
        'or else builds a new one within 16 blocks of it.');
    }
    return { title, facts, notes, cmd, tp, other };
  }

  function showInfo() {
    if (!selected) { info.hidden = true; info.innerHTML = ''; return; }
    const d = describe(selected);
    const a = ABOUT[aboutKey(selected)];
    const v = selected.v;
    const y = selected.group === 'spawn' ? v.y : (v.centerY ? v.centerY() : null);
    const coords = v.x + (y === null || y === undefined ? '' : ' ' + y) + ' ' + v.z;
    const isWp = selected.group === 'waypoint';
    const head = isWp ? '<input class="info-name" value="' + esc(v.name) + '" aria-label="Waypoint name" title="Rename this waypoint">'
      : '<strong>' + esc(d.title) + '</strong>';
    info.innerHTML = '<div class="info-head">' + head +
      '<button type="button" class="info-close" aria-label="Close">×</button></div>' +
      (a ? '<p class="info-about">' + esc(a[0]) + ' <a href="' + WIKI + a[1] + '" target="_blank" rel="noopener">More on the Minecraft Wiki</a></p>' : '') +
      '<dl>' + d.facts.map(([k, val]) => '<dt>' + esc(k) + '</dt><dd' + (/^X /.test(val) ? ' class="info-pos"' : '') + '>' + esc(val) + '</dd>').join('') + '</dl>' +
      d.notes.map((n) => '<p>' + n + '</p>').join('') +
      '<div class="info-buttons">' +
      '<button type="button" class="secondary info-share" title="Copy a link to this map with this item selected">Share link</button>' +
      '<button type="button" class="secondary info-copy">Copy coordinates</button>' +
      (d.cmd ? '<button type="button" class="secondary info-cmd">Copy /locate</button>' : '') +
      (d.tp ? '<button type="button" class="secondary info-tp" title="' + esc(d.tp) + ' (lands on the ground above it; needs the teleport privilege)">Copy /teleport</button>' : '') +
      (isWp ? '<button type="button" class="secondary info-wp-del">Delete waypoint</button>'
        : '<button type="button" class="secondary info-wp" title="Keep this spot in the Waypoints list (saved in this browser)">Add waypoint</button>') +
      '<button type="button" class="secondary info-ruler" title="Measure the distance from here to another spot">Measure from here</button>' +
      (d.other ? '<button type="button" class="secondary info-other" title="Switch to the ' + d.other.dim + ' and mark where a portal here leads">Show in ' +
        (d.other.dim === 'nether' ? 'Nether' : 'overworld') + '</button>' : '') +
      '</div>' + findRow();
    info.hidden = false;
    info.querySelector('.info-close').addEventListener('click', () => select(null));
    const copyButton = (btn, text, label) => btn && btn.addEventListener('click', () => {
      const done = () => { btn.textContent = label; };
      try { navigator.clipboard.writeText(text).then(done, () => { btn.textContent = text; }); }
      catch (e) { btn.textContent = text; }
    });
    copyButton(info.querySelector('.info-copy'), coords, 'Copied ' + coords);
    copyButton(info.querySelector('.info-cmd'), d.cmd, 'Copied /locate');
    copyButton(info.querySelector('.info-tp'), d.tp, 'Copied /teleport');
    copyButton(info.querySelector('.info-share'), shareLink(selected), 'Copied link');
    const sel = selected;
    const on = (cls, fn) => { const b = info.querySelector(cls); if (b) b.addEventListener('click', fn); };
    on('.info-wp', () => select({ group: 'waypoint', v: addWaypoint(v.x, v.z, sel.group === 'spot' ? '' : d.title) }));
    on('.info-wp-del', () => deleteWaypoint(v));
    on('.info-ruler', () => startRuler(v.x, v.z));
    on('.info-other', () => showOther(d.other));
    on('.info-find button', () => {
      if (finding) { stopFind('Find nearest'); return; }
      startFind(info.querySelector('.info-find select').value, v.x, v.z);
    });
    const name = info.querySelector('.info-name');
    if (name) name.addEventListener('input', () => { v.name = name.value.trim() || 'Waypoint'; saveWaypoints(); });
  }

  // A link that opens the map centered on the item with its card showing.
  function shareLink(sel) {
    const p = new URLSearchParams({ seed: seedText, x: sel.v.x, z: sel.v.z, zoom: view.zi, view: mode,
      sel: sel.group + ',' + sel.v.x + ',' + sel.v.z });
    if (dim !== 'overworld') p.set('dim', dim);
    if (waypoints.length) p.set('wp', waypointsParam());
    if (mapgenLimit !== 31007) p.set('limit', mapgenLimit);
    return location.href.split('#')[0] + '#' + p.toString();
  }
  // From a shared link: select the item once its layer has been worked out.
  let pendingSel = null;
  function findPending() {
    if (!pendingSel || !seedText) return;
    const { group, x, z } = pendingSel;
    if (group === 'spot') { pendingSel = null; select({ group, v: { x, z } }); return; }
    if (group === 'waypoint') {
      const w = waypoints.find((o) => o.dim === dim && o.x === x && o.z === z);
      pendingSel = null;
      if (w) select({ group, v: w });
      return;
    }
    const [px, py] = toScreen(x + 0.5, z + 0.5);
    const near = { village: villageNear, strong: strongNear, land: landNear, ocean: oceanNear, temple: templeNear,
      portal: portalNear, nether: netherNear, end: endNear, spawn: () => spawnInfo && spawnNear(px, py) && spawnInfo.nearest }[group];
    const v = near && near(px, py);
    if (v && v.x === x && v.z === z) { pendingSel = null; select({ group, v }); }
  }

  // The details that used to fill the footer, shown in the info card.
  function showAbout() {
    selected = null; requestDraw();
    info.innerHTML = '<div class="info-head"><strong>About Antichunk</strong>' +
      '<button type="button" class="info-close" aria-label="Close">×</button></div>' +
      '<p>A seed map for Luanti worlds made with Mineclonia, using the v7 map generator with default settings. ' +
      'It was built from Luanti 5.19 (development version of November 9, 2026) and Mineclonia as of November 4, 2026.</p>' +
      '<p>Biomes come from Mineclonia\'s biome list. Villages, ruined portals, temples (desert pyramids, jungle temples, igloos, ' +
      'swamp huts), ocean structures (shipwrecks, ocean ruins, monuments), woodland mansions, pillager outposts, trail ruins, ' +
      'trial chambers, buried treasure, mineshafts and strongholds are placed the way Mineclonia places them. A red outline ' +
      'marks an abandoned village.</p>' +
      '<p>The dashed square around the spawn star is where new players can appear. Caves are not shown.</p>' +
      '<p>Click any icon to see what it is and how to find it in game, or any other spot for its details and tools.</p>' +
      '<p>A world made with a smaller <code>mapgen_limit</code> setting ends sooner: set it under "World settings" at the bottom of the layers panel.</p>' +
      '<p>Antichunk is free software under the GPL-3.0 license, because it uses data from Mineclonia.</p>' +
      '<p><a href="https://www.luanti.org/" target="_blank" rel="noopener">Luanti</a> is the free voxel game engine.<br>' +
      '<a href="https://content.luanti.org/packages/ryvnf/mineclonia/" target="_blank" rel="noopener">Mineclonia</a> is the game ' +
      '(<a href="https://codeberg.org/mineclonia/mineclonia" target="_blank" rel="noopener">source code</a>).</p>' +
      '<p><a class="gh-link" href="' + (PROJECT_URL || '#') + '"' + (PROJECT_URL ? ' target="_blank" rel="noopener"' : '') +
      ' title="Antichunk on GitHub">' + GITHUB_MARK + 'Antichunk 0.1.22, crafted by buddyholly</a></p>' +
      '<p>Live map: <a href="https://buddyhollyy.github.io/Antichunk/" target="_blank" rel="noopener">buddyhollyy.github.io/Antichunk</a></p>';
    info.hidden = false;
    info.querySelector('.info-close').addEventListener('click', () => select(null));
  }
  document.getElementById('about-link').addEventListener('click', (e) => { e.preventDefault(); showAbout(); });

  function select(sel) {
    if (finding && !(sel && sel.from)) stopFind();
    selected = sel;
    showInfo();
    requestDraw();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target.tagName === 'INPUT') return;
    if (selected || !info.hidden) select(null); else if (ruler) clearRuler();
  });

  // ------------------------------------------------------------ strongholds
  // 128 in rings around the world center; each needs a slow biome search,
  // done only for strongholds near the view, one or two per frame.
  let showStrong = true, strongFinder = null;
  let shownStrong = [];

  function drawStrongholds(w, h) {
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    const deadline = frameDeadline;
    let unfinished = false, did = false;
    shownStrong = [];
    if (hiddenKinds.has('stronghold')) return;
    for (const s of strongFinder.near(x0, z0, x1, z1)) {
      if (s.result === undefined) {
        if (did && performance.now() > deadline) { unfinished = true; continue; }
        strongFinder.resolve(s); did = true;
      }
      const o = s.result;
      if (!o || !inWorld(o)) continue;
      const [px, py] = toScreen(o.x + 0.5, o.z + 0.5);
      if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
      shownStrong.push({ v: o, px, py });
      stamp('eye', px, py, drawEye);
    }
    if (unfinished) requestDraw();
  }

  // An eye of ender.
  function drawEye(px, py) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#2f8f6f'; ctx.strokeStyle = '#1b1d22'; ctx.lineWidth = 2; ctx.stroke(); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, 0, 7, 4, 0, 0, Math.PI * 2); ctx.fillStyle = '#d8f5c8'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fillStyle = '#1b1d22'; ctx.fill();
    ctx.restore();
  }

  function strongNear(mx, my) {
    let best = null, bd = 14 * 14;
    for (const s of shownStrong) {
      const d = (s.px - mx) ** 2 + (s.py - my) ** 2;
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  document.getElementById('show-strong').addEventListener('change', (e) => {
    showStrong = e.target.checked; requestDraw();
  });

  document.getElementById('show-land').addEventListener('change', (e) => {
    showLand = e.target.checked; requestDraw();
  });

  document.getElementById('show-ocean').addEventListener('change', (e) => {
    showOcean = e.target.checked; requestDraw();
  });

  document.getElementById('show-temples').addEventListener('change', (e) => {
    showTemples = e.target.checked; requestDraw();
  });

  document.getElementById('show-portals').addEventListener('change', (e) => {
    showPortals = e.target.checked; requestDraw();
  });

  document.getElementById('show-end').addEventListener('change', (e) => {
    showEnd = e.target.checked; requestDraw();
  });
  document.getElementById('show-nether').addEventListener('change', (e) => {
    showNether = e.target.checked; requestDraw();
  });

  // Overworld or Nether.  Each has its own tiles and layers; the panel shows
  // only the current one's layers.
  function setDim(d) {
    dim = d === 'nether' || d === 'end' ? d : 'overworld';
    for (const r of document.querySelectorAll('input[name=dim]')) r.checked = r.value === dim;
    document.getElementById('mode').hidden = dim !== 'overworld'; // one view only in the Nether and End
    for (const sec of document.querySelectorAll('#panel section[data-dim]')) sec.hidden = sec.dataset.dim !== dim;
    if (selected) select(null);
    if (ruler) clearRuler();
    stopFind();
    lastViewKey = '';
    fillHighlight();
    renderWaypoints();
    saveHash();
    requestDraw();
  }
  for (const r of document.querySelectorAll('input[name=dim]')) {
    r.addEventListener('change', () => { if (r.checked) setDim(r.value); });
  }

  document.getElementById('show-villages').addEventListener('change', (e) => {
    showVillages = e.target.checked; requestDraw();
  });

  // Biome names as Mineclonia writes them, made easier to read:
  // "MesaPlateauF_ocean" -> "Mesa Plateau F (ocean)".
  function biomeLabel(name) {
    const m = name.match(/^(.*?)(?:_(.*))?$/);
    const base = m[1].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    return m[2] ? base + ' (' + m[2].replace(/_/g, ' ') + ')' : base;
  }

  for (const r of document.querySelectorAll('input[name=mode]')) {
    if (r.value === mode) r.checked = true;
    r.addEventListener('change', () => { if (r.checked) { mode = r.value; saveHash(); requestDraw(); } });
  }

  // ------------------------------------------------------------ seed
  function setSeed(text) {
    seedText = text;
    generation++;
    document.getElementById('empty').hidden = text !== '';
    // Work already sent to workers finishes, but its results are ignored.
    cache.clear(); queue = []; queued.clear();
    if (selected) select(null);
    if (ruler) clearRuler();
    if (text === '') { seedInfo.textContent = ''; waypoints = []; renderWaypoints(); requestDraw(); return; }
    const s64 = N.readSeed(text);
    seed32 = N.mapgenSeed(s64);
    world = new window.MclVillages.World(text);
    mainFinders = new window.MclIconJobs.Finders(text);
    stopFind();
    iconGen++; iconQueue = []; iconQueued.clear(); iconSent.clear();
    villageCache.clear();
    portalFinder = new window.MclPortals.Portals(world);
    portalCache.clear();
    templeFinder = new window.MclTemples.Temples(world);
    templeCache.clear();
    oceanFinder = new window.MclOcean.Ocean(world);
    oceanCache.clear();
    landFinder = new window.MclLandmarks.Landmarks(world);
    landCache.clear();
    strongFinder = new window.MclStrongholds.Strongholds(world);
    slime = new window.MclSlime.Slime(world.levelSeed);
    slimeBlocks.clear();
    netherFinder = new window.MclNether.Nether(world);
    netherCache.clear(); netherPortalCache.clear();
    findSpawnLater();
    seed64 = s64.toString();
    loadStoreKeys();
    loadWaypoints();
    rememberSeed(text);
    if (!limitFromHash) {
      let l;
      try { l = JSON.parse(localStorage.getItem(LIMIT_KEY) || '{}')[seed64]; } catch (e) { /* storage blocked */ }
      applyLimit(l === undefined ? 31007 : l);
    }
    limitFromHash = false;
    seedInfo.textContent = 'World seed ' + s64.toString();
    saveHash();
    requestDraw();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setSeed(seedInput.value);
  });
  gotoForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const x = Number(gotoX.value), z = Number(gotoZ.value);
    if (Number.isFinite(x) && Number.isFinite(z)) { view.x = x; view.z = z; saveHash(); requestDraw(); }
  });

  // ------------------------------------------------------------ pan / zoom
  let drag = null;
  // Two fingers on a touch screen: pinch to zoom, move to pan.  The map
  // has fixed zoom levels, so while pinching the picture is stretched
  // smoothly and the next level (twice or half the size) is switched to
  // each time the fingers spread or close by a factor of 2.
  const touches = new Map();   // pointerId -> [clientX, clientY]
  let pinch = null, gesture = false;
  const pinchState = () => {
    const [a, b] = [...touches.values()];
    const r = canvas.parentElement.getBoundingClientRect();   // not stretched, unlike the canvas
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2 - r.left, my: (a[1] + b[1]) / 2 - r.top };
  };
  const setStretch = (k, ox, oy) => {
    canvas.style.transformOrigin = ox + 'px ' + oy + 'px';
    canvas.style.transform = k === 1 ? '' : 'scale(' + k + ')';
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 2) {
      drag = null; gesture = true;
      pinch = pinchState();
      return;
    }
    if (touches.size > 2) return;
    drag = { px: e.clientX, py: e.clientY, x: view.x, z: view.z };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && touches.size >= 2) {
      const now = pinchState(), s = scale();
      view.x -= (now.mx - pinch.mx) / s;      // pan with the fingers' midpoint
      view.z += (now.my - pinch.my) / s;
      pinch.mx = now.mx; pinch.my = now.my;
      let k = now.d / pinch.d;
      if (k >= 2 && view.zi > 0) { setStretch(1, 0, 0); zoomAt(-1, now.mx, now.my); pinch.d = now.d; k = 1; }
      else if (k <= 0.5 && view.zi < ZOOMS.length - 1) { setStretch(1, 0, 0); zoomAt(1, now.mx, now.my); pinch.d = now.d; k = 1; }
      setStretch(Math.max(0.5, Math.min(2, k)), now.mx, now.my);
      requestDraw();
      return;
    }
    mouse = [e.clientX - r.left, e.clientY - r.top];
    if (ruler && !ruler.b) { updateRuler(); requestDraw(); }
    if (drag) {
      const s = scale();
      view.x = drag.x - (e.clientX - drag.px) / s;
      view.z = drag.z + (e.clientY - drag.py) / s;
      requestDraw();
    } else {
      updateReadout();
    }
  });
  const endDrag = () => { if (drag) { drag = null; canvas.classList.remove('dragging'); saveHash(); } };
  // Lifting a finger ends the pinch; a part-way stretch snaps to the
  // nearer zoom level.
  function endPointer(e) {
    touches.delete(e.pointerId);
    if (pinch && touches.size < 2) {
      const k = canvas.style.transform ? Number(canvas.style.transform.slice(6, -1)) : 1;
      setStretch(1, 0, 0);
      if (k > 1.41) zoomAt(-1, pinch.mx, pinch.my); else if (k < 0.71) zoomAt(1, pinch.mx, pinch.my);
      pinch = null;
      canvas.classList.remove('dragging');
      saveHash(); requestDraw();
    }
    if (!touches.size) gesture = false;
  }
  // A press that barely moves is a click: select the icon under it.
  canvas.addEventListener('pointerup', (e) => {
    const wasGesture = gesture;
    endPointer(e);
    if (wasGesture) { drag = null; return; }
    if (drag && Math.abs(e.clientX - drag.px) < 5 && Math.abs(e.clientY - drag.py) < 5) {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (ruler && !ruler.b) {
        const [wx, wz] = toWorld(mx, my);
        ruler.b = [Math.floor(wx) + 0.5, Math.floor(wz) + 0.5];
        updateRuler(); requestDraw();
      } else if (seedText) {
        const [wx, wz] = toWorld(mx, my);
        select(itemAt(mx, my) || { group: 'spot', v: { x: Math.floor(wx), z: Math.floor(wz) } });
      }
    }
    endDrag();
  });
  canvas.addEventListener('pointercancel', (e) => { endPointer(e); endDrag(); });
  canvas.addEventListener('pointerleave', () => { mouse = null; updateReadout(); if (ruler && !ruler.b) { updateRuler(); requestDraw(); } });

  function zoomAt(dir, px, py) {
    const zi = Math.max(0, Math.min(ZOOMS.length - 1, view.zi + dir));
    if (zi === view.zi) return;
    const [wx, wz] = toWorld(px, py);
    view.zi = zi;
    const [nx, nz] = toWorld(px, py);
    view.x += wx - nx; view.z += wz - nz;
    saveHash();
    requestDraw();
  }
  let wheelAcc = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 60) return;
    const r = canvas.getBoundingClientRect();
    zoomAt(wheelAcc > 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    wheelAcc = 0;
  }, { passive: false });
  document.getElementById('zoom-in').addEventListener('click', () => zoomAt(-1, size().w / 2, size().h / 2));
  document.getElementById('zoom-out').addEventListener('click', () => zoomAt(1, size().w / 2, size().h / 2));

  // Full screen: the map and the layers panel together.  Browsers without
  // the Fullscreen API for ordinary page elements never show the button.
  const fsButton = document.getElementById('fullscreen'), fsTarget = document.getElementById('body');
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    fsButton.hidden = false;
    fsButton.addEventListener('click', () => {
      if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
    });
    const onFs = () => {
      const on = !!fsElement();
      fsTarget.classList.toggle('is-full', on);
      // Full screen shows the layers too, except on narrow (portrait phone)
      // screens, where the panel would cover most of the map.
      if (on && panel.hidden && window.innerWidth > 600) setPanel(true);
      fsButton.title = on ? 'Leave full screen' : 'Full screen';
      fsButton.setAttribute('aria-label', fsButton.title);
      curSize = null; requestDraw();
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
  }
  window.addEventListener('resize', requestDraw);

  // ------------------------------------------------------------ type buttons
  // Next to each group's checkbox: one button per structure type, showing
  // the same icon as the map.  Pressing one hides or shows that type.
  const TYPES = {
    villages: [
      ['village_plains', 'Plains villages', (x, y) => drawHouse(x, y, VILLAGE_COLOR.plains, false)],
      ['village_desert', 'Desert villages', (x, y) => drawHouse(x, y, VILLAGE_COLOR.desert, false)],
      ['village_savannah', 'Savanna villages', (x, y) => drawHouse(x, y, VILLAGE_COLOR.savannah, false)],
      ['village_snowy', 'Snowy villages', (x, y) => drawHouse(x, y, VILLAGE_COLOR.snowy, false)],
      ['village_taiga', 'Taiga villages', (x, y) => drawHouse(x, y, VILLAGE_COLOR.taiga, false)],
    ],
    spawn: [
      ['spawn', 'Spawn point', (x, y) => drawStar(x, y)],
    ],
    portals: [
      ['portal', 'Ruined portals', (x, y) => drawPortal(x, y, false)],
    ],
    end: [
      ['end_portal', 'Exit portal', (x, y) => drawEndIcon(x, y, 'end_portal')],
      ['end_platform', 'Arrival platform', (x, y) => drawEndIcon(x, y, 'end_platform')],
      ['end_spike', 'Obsidian pillars', (x, y) => drawEndIcon(x, y, 'end_spike')],
      ['end_gateway', 'Gateway spots', (x, y) => drawEndIcon(x, y, 'end_gateway')],
    ],
    nether: [
      ['fortress', 'Nether fortresses', (x, y) => drawNetherIcon(x, y, 'fortress')],
      ['bastion', 'Bastion remnants', (x, y) => drawNetherIcon(x, y, 'bastion')],
      ['nether_portal', 'Ruined portals', (x, y) => drawPortal(x, y, false)],
    ],
    strong: [
      ['stronghold', 'Strongholds', (x, y) => drawEye(x, y)],
    ],
    slime: [
      ['slime', 'Slime chunks', (x, y) => drawSlimeIcon(x, y)],
    ],
    temples: [
      ['desert_pyramid', 'Desert pyramids', (x, y) => drawTemple(x, y, 'desert_pyramid')],
      ['jungle_temple', 'Jungle temples', (x, y) => drawTemple(x, y, 'jungle_temple')],
      ['igloo', 'Igloos', (x, y) => drawTemple(x, y, 'igloo')],
      ['swamp_hut', 'Swamp huts', (x, y) => drawTemple(x, y, 'swamp_hut')],
    ],
    ocean: [
      ['shipwreck', 'Shipwrecks', (x, y) => drawOceanIcon(x, y, { kind: 'shipwreck' })],
      ['ocean_ruin', 'Ocean ruins', (x, y) => drawOceanIcon(x, y, { kind: 'ocean_ruin', temp: 'cold' })],
      ['monument', 'Ocean monuments', (x, y) => drawOceanIcon(x, y, { kind: 'monument' })],
    ],
    land: [
      ['outpost', 'Pillager outposts', (x, y) => drawLandIcon(x, y, 'outpost')],
      ['mansion', 'Woodland mansions', (x, y) => drawLandIcon(x, y, 'mansion')],
      ['trail_ruins', 'Trail ruins', (x, y) => drawLandIcon(x, y, 'trail_ruins')],
      ['trial_chambers', 'Trial chambers', (x, y) => drawLandIcon(x, y, 'trial_chambers')],
      ['treasure', 'Buried treasure', (x, y) => drawLandIcon(x, y, 'treasure')],
      ['mineshaft', 'Mineshafts', (x, y) => drawLandIcon(x, y, 'mineshaft')],
    ],
  };
  const typeButtons = new Map();

  function iconCanvas(draw) {
    const c = document.createElement('canvas');
    const d = window.devicePixelRatio || 1;
    c.width = c.height = Math.round(26 * d);
    c.style.width = c.style.height = '26px';
    const g = c.getContext('2d');
    g.scale(d, d);
    const mapCtx = ctx;
    ctx = g;
    try { draw(13, 13); } finally { ctx = mapCtx; }
    return c;
  }

  for (const box of document.querySelectorAll('.types')) {
    for (const [kind, label, draw] of TYPES[box.dataset.group]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'type';
      b.title = b.dataset.title = 'Show or hide ' + label.toLowerCase();
      b.setAttribute('aria-pressed', 'true');
      b.appendChild(iconCanvas(draw));
      const name = document.createElement('span');
      name.textContent = label;
      b.appendChild(name);
      b.addEventListener('click', () => {
        if (hiddenKinds.has(kind)) hiddenKinds.delete(kind); else hiddenKinds.add(kind);
        b.setAttribute('aria-pressed', String(!hiddenKinds.has(kind)));
        saveHash(); requestDraw();
      });
      typeButtons.set(kind, b);
      box.appendChild(b);
    }
    // Dim the buttons while their group is switched off.
    const check = box.parentElement.querySelector('input[type=checkbox]');
    check.addEventListener('change', () => box.classList.toggle('off', !check.checked));
  }

  // The side panel can be hidden to give the map more room; the choice is
  // remembered in this browser.  On narrow screens it starts hidden.
  const panel = document.getElementById('panel');
  const panelToggle = document.getElementById('panel-toggle');
  function setPanel(open) {
    panel.hidden = !open;
    document.getElementById('body').classList.toggle('panel-open', open);
    panelToggle.textContent = open ? 'Hide layers' : 'Layers';
    panelToggle.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem('seedmap-panel', open ? 'open' : 'closed'); } catch (e) { /* storage blocked */ }
    requestDraw();
  }
  let panelPref = null;
  try { panelPref = localStorage.getItem('seedmap-panel'); } catch (e) { /* storage blocked */ }
  setPanel(panelPref ? panelPref === 'open' : window.innerWidth > 600);
  panelToggle.addEventListener('click', () => setPanel(panel.hidden));
  document.getElementById('layers-btn').addEventListener('click', () => setPanel(panel.hidden));

  // ------------------------------------------------------------ highlight a biome
  // Everything outside the chosen biome is darkened.  Each map tile keeps a
  // small dark overlay for the current choice, made when it is first drawn.
  const hlSelect = document.getElementById('highlight');
  const hlWrap = document.getElementById('hl-wrap');
  let hlKey = '', hlFlags = null, hlVersion = 0, hlSeen = false;
  // Biomes that never reach the surface: Deep Dark is only at Y -128
  // (Mineclonia's mcl_biomes), and "default" is Luanti's fallback.
  const UNDERGROUND = new Set(['default', 'DeepDark']);
  // Overworld biomes are grouped by base name ("MesaPlateauF_grasstop" is
  // part of "Mesa Plateau F"); their sea floor parts make up "Ocean".
  function biomeGroups(d) {
    const groups = new Map();
    const add = (key, label, i) => {
      if (!groups.has(key)) groups.set(key, { key, label, ids: [] });
      groups.get(key).ids.push(i);
    };
    window.LuantiBiomes.BIOMES.forEach((b, i) => {
      if (NETHER_LABEL[b.name]) { if (d === 'nether') add(b.name, NETHER_LABEL[b.name], i); return; }
      if (d !== 'overworld') return;
      const cut = b.name.indexOf('_');
      const base = cut < 0 ? b.name : b.name.slice(0, cut), suffix = cut < 0 ? '' : b.name.slice(cut + 1);
      if (UNDERGROUND.has(base) || /underground/.test(suffix)) return;
      if (/ocean|water/.test(suffix)) add('Ocean', 'Ocean (any)', i);
      else add(base, biomeLabel(base), i);
    });
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
  function maskFor(t) {
    if (t.hlVersion === hlVersion) return t.mask;
    const m = t.size, img = new ImageData(m, m), px = img.data;
    let any = false;
    for (let kk = 0; kk < m; kk++) for (let ii = 0; ii < m; ii++) {
      if (hlFlags[t.biome[kk * m + ii]]) { any = true; continue; }
      const o = ((m - 1 - kk) * m + ii) * 4;   // image rows run north to south
      px[o] = 10; px[o + 1] = 12; px[o + 2] = 16; px[o + 3] = 200;
    }
    const c = t.mask && t.mask.width === m ? t.mask : document.createElement('canvas');
    c.width = c.height = m;
    c.getContext('2d').putImageData(img, 0, 0);
    t.mask = c; t.maskAny = any; t.hlVersion = hlVersion;
    return c;
  }
  function setHighlight(key) {
    const g = dim === 'end' ? null : biomeGroups(dim).find((x) => x.key === key);
    hlKey = g ? key : '';
    hlFlags = null;
    if (g) { hlFlags = new Uint8Array(256); for (const i of g.ids) hlFlags[i] = 1; }
    hlVersion++;
    hlSelect.value = hlKey;
    saveHash(); requestDraw();
  }
  // The list holds the current dimension's biomes; the End has none.
  function fillHighlight() {
    hlWrap.hidden = dim === 'end';
    const groups = dim === 'end' ? [] : biomeGroups(dim);
    hlSelect.innerHTML = '<option value="">None</option>' +
      groups.map((g) => '<option value="' + esc(g.key) + '">' + esc(g.label) + '</option>').join('');
    setHighlight(groups.some((g) => g.key === hlKey) ? hlKey : '');
  }
  hlSelect.addEventListener('change', () => setHighlight(hlSelect.value));

  // ------------------------------------------------------------ waypoints
  // Saved in this browser, per world seed.  Shared links carry them along,
  // and opening such a link adds them to the list.
  const WP_KEY = 'antichunk-waypoints', WP_COLOR = '#ff5c8a', SPOT_COLOR = '#ffd84d';
  const wpList = document.getElementById('wp-list');
  let waypoints = [], showWp = true, shownWp = [];
  const validWp = (w) => w && ['overworld', 'nether', 'end'].includes(w.dim) && Number.isInteger(w.x) &&
    Number.isInteger(w.z) && typeof w.name === 'string';
  function readAllWp() {
    try { const a = JSON.parse(localStorage.getItem(WP_KEY) || '{}'); return a && typeof a === 'object' ? a : {}; }
    catch (e) { return {}; }
  }
  function loadWaypoints() {
    const a = readAllWp()[seed64];
    waypoints = Array.isArray(a) ? a.filter(validWp) : [];
    renderWaypoints();
  }
  function saveWaypoints() {
    const all = readAllWp();
    if (waypoints.length) all[seed64] = waypoints; else delete all[seed64];
    try { localStorage.setItem(WP_KEY, JSON.stringify(all)); } catch (e) { /* storage blocked: kept until reload */ }
    renderWaypoints(); requestDraw();
  }
  function addWaypoint(x, z, name) {
    let w = waypoints.find((o) => o.dim === dim && o.x === x && o.z === z);
    if (!w) {
      w = { dim, x, z, name: name || 'Waypoint ' + (waypoints.length + 1) };
      waypoints.push(w); saveWaypoints();
    }
    return w;
  }
  function deleteWaypoint(w) {
    waypoints = waypoints.filter((o) => o !== w);
    if (selected && selected.v === w) select(null);
    saveWaypoints();
  }
  // In a link: "o,x,z,name;n,x,z,name" (first letter of the dimension).
  function waypointsParam() {
    return waypoints.slice(0, 50).map((w) => w.dim[0] + ',' + w.x + ',' + w.z + ',' + encodeURIComponent(w.name)).join(';');
  }
  function importWaypoints(text) {
    const dims = { o: 'overworld', n: 'nether', e: 'end' };
    let added = false;
    for (const part of text.split(';').slice(0, 50)) {
      const [d, x, z, name] = part.split(',');
      let w;
      try { w = { dim: dims[d], x: Number(x), z: Number(z), name: decodeURIComponent(name || '').slice(0, 60) || 'Waypoint' }; }
      catch (e) { continue; }
      if (!validWp(w) || waypoints.some((o) => o.dim === w.dim && o.x === w.x && o.z === w.z)) continue;
      waypoints.push(w); added = true;
    }
    if (added) saveWaypoints();
  }
  function renderWaypoints() {
    const mine = waypoints.filter((w) => w.dim === dim);
    wpList.innerHTML = '';
    if (!mine.length) {
      const p = document.createElement('p');
      p.className = 'wp-empty';
      p.textContent = 'Click a spot on the map, then “Add waypoint”.';
      wpList.appendChild(p);
      return;
    }
    for (const w of mine) {
      const row = document.createElement('div');
      row.className = 'wp-row';
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'type'; go.title = 'Go to ' + w.name;
      go.appendChild(iconCanvas((x, y) => drawPin(x, y + 10, WP_COLOR, 0.9)));
      const name = document.createElement('span');
      name.textContent = w.name;
      const at = document.createElement('small');
      at.textContent = w.x + ', ' + w.z;
      const text = document.createElement('div');
      text.className = 'wp-text';
      text.append(name, at);
      go.appendChild(text);
      go.addEventListener('click', () => {
        view.x = w.x + 0.5; view.z = w.z + 0.5; saveHash();
        select({ group: 'waypoint', v: w });
      });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'wp-del'; del.textContent = '×';
      del.title = 'Delete ' + w.name; del.setAttribute('aria-label', del.title);
      del.addEventListener('click', () => deleteWaypoint(w));
      row.append(go, del);
      wpList.appendChild(row);
    }
  }
  document.getElementById('show-wp').addEventListener('change', (e) => {
    showWp = e.target.checked; wpList.classList.toggle('off', !showWp); requestDraw();
  });
  // A map pin whose tip is at (px, py).
  function drawPin(px, py, color, k = 1, halo = false) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.scale(k, k);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-2, -5, -8, -9, -8, -15);
    ctx.arc(0, -15, 8, Math.PI, 0);
    ctx.bezierCurveTo(8, -9, 2, -5, 0, 0);
    ctx.closePath();
    if (halo) { ctx.lineWidth = 5; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#1b1d22'; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -15, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#1b1d22'; ctx.fill();
    ctx.restore();
  }
  function drawWaypoints(w, h) {
    shownWp = [];
    ctx.save();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const o of waypoints) {
      if (o.dim !== dim) continue;
      const [px, py] = toScreen(o.x + 0.5, o.z + 0.5);
      if (px < -150 || py < -30 || px > w + 30 || py > h + 30) continue;
      shownWp.push({ v: o, px, py });
      stamp('wp', px, py, (x, y) => drawPin(x, y, WP_COLOR));
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(20,22,26,0.9)';
      ctx.strokeText(o.name, Math.round(px) + 10, Math.round(py) - 15);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(o.name, Math.round(px) + 10, Math.round(py) - 15);
    }
    ctx.restore();
  }
  function waypointNear(mx, my) {
    let best = null, bd = 12 * 12;
    for (const s of shownWp) {
      const d = (s.px - mx) ** 2 + (s.py - 13 - my) ** 2;   // the pin's head
      if (d < bd) { bd = d; best = s.v; }
    }
    return best;
  }

  // ------------------------------------------------------------ portals
  // Where a Nether portal on (x, z) leads, as Mineclonia works it out
  // (mcl_portals/portal_nether.lua): overworld X and Z divided by 8 and
  // rounded (halves away from zero, like Luanti's math.round); Nether X and Z
  // times 8, folded back in at the map's edge (30912 with the default
  // mapgen_limit of 31000).
  const lround = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
  function portalTarget(x, z) {
    if (dim === 'overworld') return { dim: 'nether', x: lround(x / 8), z: lround(z / 8) };
    if (dim !== 'nether') return null;
    const E = PORTAL_EDGE, S = 2 * E;
    const back = (v) => { const u = v * 8 + E; return E - Math.abs((((u % (2 * S)) + 2 * S) % (2 * S)) - S); };
    return { dim: 'overworld', x: back(x), z: back(z) };
  }
  function showOther(t) {
    setDim(t.dim);
    view.x = t.x + 0.5; view.z = t.z + 0.5;
    saveHash();
    select({ group: 'spot', v: { x: t.x, z: t.z } });
  }

  // ------------------------------------------------------------ ruler
  // "Measure from here" on a card, then a click on the map: the straight
  // line distance between the two spots.
  let ruler = null; // { dim, a: [x, z], b: [x, z] or null while choosing }
  const rulerBox = document.getElementById('ruler-box');
  rulerBox.querySelector('.ruler-clear').addEventListener('click', () => clearRuler());
  function startRuler(x, z) {
    ruler = { dim, a: [x + 0.5, z + 0.5], b: null };
    select(null);
    updateRuler(); requestDraw();
  }
  function clearRuler() { ruler = null; updateRuler(); requestDraw(); }
  function rulerEnd() {
    if (ruler.b) return ruler.b;
    if (!mouse) return null;
    const [wx, wz] = toWorld(mouse[0], mouse[1]);
    return [Math.floor(wx) + 0.5, Math.floor(wz) + 0.5];
  }
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
  function rulerLabel() {
    const e = rulerEnd();
    if (!e) return null;
    const dx = e[0] - ruler.a[0], dz = e[1] - ruler.a[1], d = Math.hypot(dx, dz);
    let t = fmt(d) + ' blocks (X ' + signed(dx) + ', Z ' + signed(dz) + ')';
    if (ruler.dim === 'overworld') t += ' · about ' + fmt(d / 8) + ' through the Nether';
    else if (ruler.dim === 'nether') t += ' · ' + fmt(d * 8) + ' in the overworld';
    return { short: fmt(d), long: t };
  }
  function updateRuler() {
    rulerBox.hidden = !ruler;
    if (!ruler) return;
    const l = rulerLabel();
    rulerBox.querySelector('.ruler-text').textContent = ruler.b ? 'Distance ' + l.long
      : 'Click the end point' + (l ? ': ' + l.long : '.') + ' Esc cancels.';
  }
  function drawRuler() {
    if (!ruler || ruler.dim !== dim) return;
    const e = rulerEnd();
    const [ax, ay] = toScreen(ruler.a[0], ruler.a[1]);
    ctx.save();
    const dot = (x, y) => {
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#1b1d22'; ctx.stroke();
    };
    if (e) {
      const [bx, by] = toScreen(e[0], e[1]);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(20,22,26,0.8)'; ctx.stroke();
      ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.setLineDash([]);
      dot(bx, by);
      const l = rulerLabel();
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.lineJoin = 'round';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(20,22,26,0.9)';
      ctx.strokeText(l.short, (ax + bx) / 2, (ay + by) / 2 - 6);
      ctx.fillStyle = '#ffffff'; ctx.fillText(l.short, (ax + bx) / 2, (ay + by) / 2 - 6);
    }
    dot(ax, ay);
    ctx.restore();
  }

  // ------------------------------------------------------------ find nearest
  // From a card: search outward, ring by ring of placement regions, for
  // the nearest structure of one type.  The regions are worked out on the
  // worker threads ahead of all other work, and the answers also fill the
  // map's own icon lists.  Strongholds are a fixed list and are checked in
  // order of distance on this page.
  let finding = null, lastFind = 'village_plains';
  let findQueue = [];
  const findQueued = new Set();
  const FIND_GROUP = { portal: 'portal', stronghold: 'strong', fortress: 'nether', bastion: 'nether', nether_portal: 'nether' };
  function findGroupOf(kind) {
    if (FIND_GROUP[kind]) return FIND_GROUP[kind];
    if (/^village_/.test(kind)) return 'village';
    if (window.MclTemples.KINDS.includes(kind)) return 'temple';
    return window.MclOcean.LAYERS[kind] ? 'ocean' : 'land';
  }
  function findRow() {
    if (dim === 'end' || !seedText) return '';
    const groups = dim === 'nether' ? ['nether'] : ['villages', 'portals', 'temples', 'ocean', 'land', 'strong'];
    const opts = [];
    for (const g of groups) for (const [kind, label] of TYPES[g]) opts.push([kind, label]);
    const pick = opts.some((o) => o[0] === lastFind) ? lastFind : opts[0][0];
    return '<div class="info-find"><select aria-label="Structure to find">' +
      opts.map(([k, l]) => '<option value="' + k + '"' + (k === pick ? ' selected' : '') + '>' + esc(l) + '</option>').join('') +
      '</select><button type="button" class="secondary">' + (finding ? 'Cancel' : 'Find nearest') + '</button></div>';
  }
  // How to search for one structure type: its region size, how to find the
  // region of a spot, and the job and cache entry for each region.
  function findSpec(kind) {
    const group = findGroupOf(kind);
    const one = (o) => (o ? (Array.isArray(o) ? o : [o]) : []);
    if (group === 'village') {
      const V = window.MclVillages, t = kind.slice(8);
      return { R: V.SPACING * 16, region: V.regionOf, cache: villageCache, id: (rx, rz) => 'village|' + rx + ',' + rz,
        job: (rx, rz) => ['village', rx, rz], list: (o) => one(o).filter((v) => v.type === t) };
    }
    if (group === 'portal') {
      const P = window.MclPortals;
      return { R: P.SPACING * 16, region: P.regionOf, cache: portalCache, id: (rx, rz) => 'portal|' + rx + ',' + rz,
        job: (rx, rz) => ['portal', rx, rz], list: one };
    }
    if (group === 'temple') {
      const T = window.MclTemples;
      return { R: T.SPACING * 16, region: T.regionOf, cache: templeCache, id: (rx, rz) => 'temple|' + kind + ',' + rx + ',' + rz,
        job: (rx, rz) => ['temple', kind, rx, rz], list: one };
    }
    if (group === 'ocean' || group === 'land') {
      const O = group === 'ocean' ? window.MclOcean : window.MclLandmarks, L = O.LAYERS[kind];
      return { R: L.spacing * 16, region: (x, z) => O.regionOf(L.spacing, x, z), cache: group === 'ocean' ? oceanCache : landCache,
        id: (rx, rz) => group + '|' + kind + ',' + rx + ',' + rz, job: (rx, rz) => [group, L.fn, rx, rz], list: one };
    }
    const NE = window.MclNether;
    if (kind === 'nether_portal') {
      return { R: window.MclPortals.SPACING * 16, region: NE.portalRegionOf, cache: netherPortalCache,
        id: (rx, rz) => 'netherPortal|' + rx + ',' + rz, job: (rx, rz) => ['netherPortal', rx, rz], list: one };
    }
    return { R: NE.SPACING * 16, region: NE.regionOf, cache: netherCache, id: (rx, rz) => 'nether|' + rx + ',' + rz,
      job: (rx, rz) => ['nether', rx, rz], list: (o) => one(o).filter((v) => v.kind === kind) };
  }
  // The regions max(|dx|, |dz|) = r away from region (cx, cz).
  function ringOf(cx, cz, r) {
    if (r === 0) return [[cx, cz]];
    const out = [];
    for (let d = -r; d <= r; d++) out.push([cx + d, cz - r], [cx + d, cz + r]);
    for (let d = -r + 1; d < r; d++) out.push([cx - r, cz + d], [cx + r, cz + d]);
    return out;
  }
  function setFindButton(text) {
    const b = info.querySelector('.info-find button');
    if (b) b.textContent = text;
  }
  function stopFind(label) {
    if (!finding) return;
    clearInterval(finding.timer);
    finding = null;
    findQueue = []; findQueued.clear();
    if (label) setFindButton(label);
  }
  function startFind(kind, x, z) {
    stopFind();
    lastFind = kind;
    const st = { kind, x, z, gen: iconGen, best: null, bestD: Infinity, r: 0 };
    if (kind === 'stronghold') {
      const pos = (s) => [s.cx * 16 + 8, -(s.cz * 16 + 8) - 1];
      st.todo = strongFinder.rings.slice().sort((a, b) => Math.hypot(pos(a)[0] - x, pos(a)[1] - z) - Math.hypot(pos(b)[0] - x, pos(b)[1] - z));
      st.pos = pos;
    } else {
      st.spec = findSpec(kind);
      st.home = st.spec.region(x, z);
    }
    finding = st;
    st.timer = setInterval(findTick, 250);
    setFindButton('Cancel');
    findTick();
  }
  function findTick() {
    const st = finding;
    if (!st || st.gen !== iconGen) return;
    if (st.kind === 'stronghold') {
      // Each one is found by a biome search near its ring position, at most
      // 128 blocks away; stop once the next is surely further than the best.
      const end = performance.now() + 30;
      while (st.todo.length && performance.now() < end) {
        const s = st.todo[0], [px, pz] = st.pos(s);
        if (Math.hypot(px - st.x, pz - st.z) - 128 > st.bestD) { st.todo = []; break; }
        st.todo.shift();
        const o = strongFinder.resolve(s);
        if (!o || !inWorld(o)) continue;
        const d = Math.hypot(o.x - st.x, o.z - st.z);
        if (d < st.bestD) { st.bestD = d; st.best = o; }
      }
      if (st.todo.length) { setFindButton('Searching…'); return; }
      return findDone(st);
    }
    const { spec } = st, R = spec.R;
    // Rings already complete: take their structures; stop when no region
    // further out could hold anything closer (a region r + 1 rings out is
    // at least r region widths away).
    const outside = (rx, rz) => {
      const [wx, wz] = [(rx + 0.5) * R, -(rz + 0.5) * R];
      return wx < WORLD_MIN - R || wx > WORLD_MAX + R || wz < WORLD_MIN - R || wz > WORLD_MAX + R;
    };
    for (;;) {
      const ring = ringOf(st.home[0], st.home[1], st.r).filter(([rx, rz]) => !outside(rx, rz));
      if (!ring.length) return findDone(st);          // past the world's edge on every side
      // Ask for this ring and the next two, so all threads keep busy.
      let missing = false;
      for (let a = 0; a < 3; a++) {
        for (const [rx, rz] of a ? ringOf(st.home[0], st.home[1], st.r + a) : ring) {
          if (outside(rx, rz)) continue;
          const id = spec.id(rx, rz), k = id.slice(id.indexOf('|') + 1);
          if (spec.cache.has(k)) continue;
          if (!a) missing = true;
          if (iconSent.has(id) || findQueued.has(id)) continue;
          const job = spec.job(rx, rz);
          if (store.keys.has('i|' + id)) { iconSent.set(id, job); store.iconReads.push({ id, job }); continue; }
          findQueued.add(id);
          findQueue.push({ id, job });
        }
      }
      if (missing) { pump(); setFindButton('Searching… ' + fmt(st.r * R) + ' blocks'); return; }
      for (const [rx, rz] of ring) {
        const id = spec.id(rx, rz);
        for (const o of spec.list(spec.cache.get(id.slice(id.indexOf('|') + 1)))) {
          const d = Math.hypot(o.x - st.x, o.z - st.z);
          if (d < st.bestD) { st.bestD = d; st.best = o; }
        }
      }
      if (st.best && st.bestD <= st.r * R - 32) return findDone(st);
      st.r++;
    }
  }
  function findDone(st) {
    stopFind();
    if (!st.best) { setFindButton('None found'); return; }
    const o = st.best, kind = st.kind, group = findGroupOf(kind);
    view.x = o.x + 0.5; view.z = o.z + 0.5;
    // Zoom in far enough for this type to show on the map.
    const m = MIN_SCALE[group === 'village' ? 'village' : group === 'nether' && kind !== 'nether_portal' ? 'nether' : kind];
    while (m && scale() < m - 1e-9 && view.zi > 0) view.zi--;
    ruler = { dim, a: [st.x + 0.5, st.z + 0.5], b: [o.x + 0.5, o.z + 0.5] };
    updateRuler();
    saveHash();
    select({ group, v: o, from: { x: st.x, z: st.z, d: st.bestD } });
  }

  // ------------------------------------------------------------ slime chunks
  // Outside swamps, slimes spawn only in slime chunks, at Y -24 and below
  // (mobs_mc/slime+magma_cube.lua).  Worked out in blocks of 16 x 16 chunks,
  // each kept as a tiny bitmap (one pixel per chunk) and scaled up.
  let showSlime = false, slime = null, slimeHidden = false;
  const slimeBlocks = new Map();
  function slimeChunk(x, z) { return [Math.floor(x / 16), Math.floor((-z - 1) / 16)]; }
  function slimeText(x, z) {
    const [cx, cz] = slimeChunk(x, z);
    return (slime.isChunk(cx, cz) ? 'yes' : 'no') + ' (X ' + cx * 16 + ' to ' + (cx * 16 + 15) +
      ', Z ' + (-cz * 16 - 16) + ' to ' + (-cz * 16 - 1) + ')';
  }
  function slimeBlock(bx, bz) {
    const k = bx + ',' + bz;
    let c = slimeBlocks.get(k);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = 16;
    const img = new ImageData(16, 16), px = img.data;
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
      if (!slime.isChunk(bx * 16 + i, bz * 16 + j)) continue;
      const o = (j * 16 + i) * 4;   // row j: Mineclonia cz grows southwards, down the screen
      px[o] = 90; px[o + 1] = 230; px[o + 2] = 70; px[o + 3] = 150;
    }
    c.getContext('2d').putImageData(img, 0, 0);
    if (slimeBlocks.size > 3000) slimeBlocks.clear();
    slimeBlocks.set(k, c);
    return c;
  }
  function drawSlime(w, h) {
    slimeHidden = false;
    if (hiddenKinds.has('slime')) return;
    if (scale() < MIN_SCALE.slime - 1e-9) { slimeHidden = true; return; }
    const s = scale(), B = 256;
    const [x0, z1] = toWorld(0, 0), [x1, z0] = toWorld(w, h);
    const [ca, cb] = [slimeChunk(x0, z1), slimeChunk(x1, z0)];
    const bx0 = Math.floor(ca[0] / 16), bx1 = Math.floor(cb[0] / 16);
    const bz0 = Math.floor(ca[1] / 16), bz1 = Math.floor(cb[1] / 16);
    let unfinished = false;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
      if (!slimeBlocks.has(bx + ',' + bz) && performance.now() > frameDeadline) { unfinished = true; continue; }
      const [sx, sy] = toScreen(bx * B, -bz * B);   // top-left: west edge, north edge
      ctx.drawImage(slimeBlock(bx, bz), Math.round(sx), Math.round(sy), Math.round(sx + B * s) - Math.round(sx), Math.round(sy + B * s) - Math.round(sy));
    }
    // Chunk borders when zoomed in far enough to see them.
    if (s >= 1 / 2) {
      ctx.strokeStyle = 'rgba(90,230,70,0.25)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let cx = ca[0]; cx <= cb[0] + 1; cx++) { const X = Math.round(toScreen(cx * 16, 0)[0]) + 0.5; ctx.moveTo(X, 0); ctx.lineTo(X, h); }
      for (let cz = ca[1]; cz <= cb[1] + 1; cz++) { const Y = Math.round(toScreen(0, -cz * 16)[1]) + 0.5; ctx.moveTo(0, Y); ctx.lineTo(w, Y); }
      ctx.stroke();
    }
    ctx.restore();
    if (unfinished) requestDraw();
  }
  // A green slime: a cube with a darker core, two eyes and a mouth.
  function drawSlimeIcon(px, py) {
    ctx.save();
    ctx.translate(Math.round(px), Math.round(py));
    ctx.lineWidth = 2; ctx.strokeStyle = '#1b1d22';
    ctx.beginPath(); ctx.rect(-9, -9, 18, 18); ctx.fillStyle = '#7ed957'; ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#5bb83a'; ctx.fillRect(-5, -5, 10, 10);
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(-6, -4, 3, 3); ctx.fillRect(3, -4, 3, 3); ctx.fillRect(-1, 3, 2, 2);
    ctx.restore();
  }
  document.getElementById('show-slime').addEventListener('change', (e) => {
    showSlime = e.target.checked; saveHash(); requestDraw();
  });

  // ------------------------------------------------------------ world size
  // mapgen_limit as set when the world was made (in its map_meta.txt).  It
  // moves the world's edge and where Nether portals fold back at the edge
  // (Mineclonia's MAP_EDGE: floor(limit / 80) * 80 - 48).  Remembered per
  // seed in this browser and carried in links.
  const LIMIT_KEY = 'antichunk-limits';
  const limitInput = document.getElementById('limit');
  const limitNote = document.getElementById('limit-note');
  let limitFromHash = false;
  function applyLimit(n) {
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) n = 31007;
    n = Math.max(1, Math.min(31007, n));
    mapgenLimit = n;
    [WORLD_MIN, WORLD_MAX] = mapgenEdges(n);
    PORTAL_EDGE = Math.floor(n / 80) * 80 - 48;
    limitInput.value = n;
    limitNote.textContent = 'World edge: X and Z from ' + WORLD_MIN + ' to ' + WORLD_MAX + '.';
  }
  function setLimit(n) {
    const before = mapgenLimit;
    applyLimit(n);
    try {
      const all = JSON.parse(localStorage.getItem(LIMIT_KEY) || '{}');
      if (mapgenLimit === 31007) delete all[seed64]; else all[seed64] = mapgenLimit;
      localStorage.setItem(LIMIT_KEY, JSON.stringify(all));
    } catch (e) { /* storage blocked */ }
    // Structures past the old edge were dropped as they came in, so work
    // them out again (saved results in the browser make this quick).
    if (mapgenLimit !== before && seedText) { limitFromHash = true; setSeed(seedText); }
    saveHash(); requestDraw();
  }
  document.getElementById('limit-form').addEventListener('submit', (e) => { e.preventDefault(); setLimit(limitInput.value); });
  document.getElementById('limit-reset').addEventListener('click', () => setLimit(31007));

  // ------------------------------------------------------------ save image
  // The map as it is on screen (terrain, icons, pins and ruler) as a PNG.
  document.getElementById('save-img').addEventListener('click', () => {
    if (!seedText) return;
    draw();
    const name = 'antichunk-' + (seedText.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'seed') + '-' + dim +
      '-x' + Math.round(view.x) + '-z' + Math.round(view.z) + '.png';
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, 'image/png');
  });

  // ------------------------------------------------------------ recent seeds
  const SEEDS_KEY = 'antichunk-seeds';
  const recentSel = document.getElementById('recent');
  function recentSeeds() {
    try { const a = JSON.parse(localStorage.getItem(SEEDS_KEY) || '[]'); return Array.isArray(a) ? a.filter((t) => typeof t === 'string') : []; }
    catch (e) { return []; }
  }
  function rememberSeed(text) {
    const list = [text, ...recentSeeds().filter((t) => t !== text)].slice(0, 10);
    try { localStorage.setItem(SEEDS_KEY, JSON.stringify(list)); } catch (e) { /* storage blocked */ }
    fillRecent(list);
  }
  function fillRecent(list) {
    recentSel.hidden = !list.length;
    recentSel.innerHTML = '<option value="" selected disabled>Recent</option>' +
      list.map((t, i) => '<option value="' + i + '">' + esc(t.length > 40 ? t.slice(0, 40) + '…' : t) + '</option>').join('');
    recentSel.list = list;
  }
  recentSel.addEventListener('change', () => {
    const t = recentSel.list[Number(recentSel.value)];
    recentSel.value = '';
    if (t === undefined) return;
    seedInput.value = t;
    setSeed(t);
  });

  // ------------------------------------------------------------ URL hash
  // #seed=...&x=..&z=..&zoom=..  so a view can be bookmarked or shared.
  function saveHash() {
    if (!seedText) return;
    const p = new URLSearchParams({ seed: seedText, x: Math.round(view.x), z: Math.round(view.z), zoom: view.zi, view: mode });
    if (hiddenKinds.size) p.set('hide', [...hiddenKinds].join(','));
    if (dim !== 'overworld') p.set('dim', dim);
    if (hlKey) p.set('hl', hlKey);
    if (showSlime) p.set('slime', '1');
    if (mapgenLimit !== 31007) p.set('limit', mapgenLimit);
    history.replaceState(null, '', '#' + p.toString());
  }
  function loadHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has('x')) view.x = Number(p.get('x')) || 0;
    if (p.has('z')) view.z = Number(p.get('z')) || 0;
    if (p.has('zoom')) view.zi = Math.max(0, Math.min(ZOOMS.length - 1, Number(p.get('zoom')) | 0));
    if (p.get('view') === 'terrain' || p.get('view') === 'biomes') {
      mode = p.get('view');
      for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === mode;
    }
    for (const kind of (p.get('hide') || '').split(',')) {
      const b = typeButtons.get(kind);
      if (b) { hiddenKinds.add(kind); b.setAttribute('aria-pressed', 'false'); }
    }
    if (p.get('dim') === 'nether' || p.get('dim') === 'end') setDim(p.get('dim'));
    if (p.has('hl')) { hlKey = p.get('hl'); fillHighlight(); }
    if (p.has('limit')) { applyLimit(Number(p.get('limit'))); limitFromHash = true; }
    if (p.get('slime') === '1') { showSlime = true; document.getElementById('show-slime').checked = true; }
    if (p.has('seed')) { seedInput.value = p.get('seed'); setSeed(p.get('seed')); }
    if (p.has('wp') && p.has('seed')) importWaypoints(p.get('wp'));
    const sel = (p.get('sel') || '').split(',');
    if (sel.length === 3 && p.has('seed')) pendingSel = { group: sel[0], x: Number(sel[1]), z: Number(sel[2]) };
  }

  fillHighlight();
  fillRecent(recentSeeds());
  renderWaypoints();
  loadHash();
  requestDraw();
})();
