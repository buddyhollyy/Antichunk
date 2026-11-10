![Antichunk] (logo/lockup.svg)

# Antichunk

Antichunk is a seed map for Luanti worlds made with Mineclonia. It is a web
page that shows the terrain of a Luanti world (v7 mapgen, default
settings) from its seed, like Chunkbase does for Minecraft.

## How to open it

Open `index.html` in a web browser (double-click it). It needs no server and
no internet connection. Type the seed exactly as it was typed when the world
was created, then press "Show map". Drag to move, use the mouse wheel or the
+ / − buttons to zoom. The address bar keeps the seed and position, so a
bookmark brings you back to the same view.

Click any icon on the map to select it. The icon is ringed and enlarged and a
card says what it is (with a link to its Minecraft Wiki article), shows its
position, how accurate that position is, and the `/locate`
command to check it in game. Press Escape or × to close the card.

## Files

- `index.html`: the finished page, built from the files below. Do not edit
  it directly; edit `src/` and `js/`, then run `node tools/build.js`.
- `src/page.html`: page layout and styles.
- `js/app.js`: map drawing, pan/zoom, grid, position readout.
- `js/worker.js`: background worker that computes and colors one chunk.
- `tools/build.js`: pastes the scripts into `src/page.html` to make `index.html`.
- `js/biomegen.js`: a copy of Luanti's biome choice (`src/mapgen/mg_biome.cpp`):
  heat and humidity noise, nearest biome point, vertical blending.
- `js/biomes-data.js`: Mineclonia's 204 overworld biomes (heat, humidity,
  height range). Generated; do not edit by hand.
- `tools/extract_biomes.py`: reads Mineclonia's `mcl_biomes/init.lua` as text
  and writes `js/biomes-data.js`. Run it again after a Mineclonia update:
  `python3 tools/extract_biomes.py <path to a Mineclonia download>`
- `js/biome-colors.js`: colors used by the biome view.
- `js/villages.js`: village placement, ported from Mineclonia's level
  generator: Java-style random numbers, the random-spread placement
  (one candidate per 34×34-chunk region), Mineclonia's own v7 height
  model and its biome-name translation.

- `js/portals.js`: ruined portal placement, ported from Mineclonia's
  `ruined_portal.lua`: one candidate per 40×40-chunk region, the seven
  portal kinds tried in random order, each with its own height rule and
  biome list. Positions are the center of the portal, as `/locate` reports.
- `js/temples.js`: desert pyramids, jungle temples, igloos and swamp huts,
  ported from the matching Mineclonia files: one candidate per 32×32-chunk
  region for each, kept if the biome (and, for pyramids and jungle temples,
  the ground height) allows it.
- `js/ocean.js`: shipwrecks, ocean ruins (with their groups of smaller
  ruins) and ocean monuments. In v7 worlds these only appear where
  Mineclonia's own terrain model says the ground is under the ocean.
- `js/landmarks.js`: buried treasure, mineshafts (starting chunk only),
  woodland mansions (start point only), pillager outposts (exact, including the 1-in-5 roll
  and the no-outpost zone around village candidates), trail ruins and
  trial chambers. For the last two the map marks the starting room, which
  can be some way from the center `/locate` reports.
- `js/strongholds.js`: the 128 strongholds in rings around the world
  center, each moved toward a preferred biome as Mineclonia does. The map
  marks the chunk each one starts in.
- `js/spawn.js`: Luanti's spawn search for v7 (`Server::findSpawnPos` and
  `getSpawnLevelAtPoint`). The engine picks random points, not tied to the
  seed, so the map shows the suitable spot nearest 0,0 and a square that
  holds about 95% of spawns from repeating the search.
- `js/nether.js`: Nether biomes, fortresses and bastion remnants (from
  Mineclonia's fortress_bastion.lua), shown with the Overworld / Nether switch.
- `js/end.js`: the End: the central island (mcl_end_island), the end stone
  island layers (Luanti ore strata from mcl_biomes) and the fixed End features.

- `js/noise.js`: a copy of Luanti's noise functions (`src/noise.cpp`) and
  seed parsing (`read_seed`), with every float operation rounded the same
  way the engine rounds it.
- `js/v7.js`: a copy of the v7 terrain shape (`src/mapgen/mapgen_v7.cpp`):
  base terrain, mountains and river channels. For each 80×80 mapchunk it
  returns the height of the highest solid node in every column, and whether
  water covers it.

## Accuracy

The JavaScript output was checked against Luanti's own C++ noise code
compiled from source. In every column tested, the surface height matched
exactly, and so did the biome (the biome check used a copy of Luanti's
biome-choice function with the real noise and random-number code).

The village code's random numbers were checked against the test values in
Mineclonia's `random.lua`, and the single-point noise against Luanti's
compiled code (60,000 points). A village was checked in a real world with `/locate`: same village, within 2
blocks (`/locate` reports the center of the whole village, the map shows its
starting point). Ruined portals still need checking with `/locate`.

Known limits:
- It assumes default v7 settings (`mgv7_spflags` = mountains, ridges,
  no floatlands; `water_level` = 1; `chunksize` = 5).
- Caves are not modeled. A cave that opens at the surface will not show.
- It matches x86-64 builds of Luanti. A build that uses fused multiply-add
  (some ARM builds) could round differently in rare cases.

## License

The terrain and biome code is ported from Luanti (LGPL-2.1-or-later). The
biome list comes from Mineclonia (GPL-3.0), so the finished page as a whole
should be shared under GPL-3.0.

## Header layouts and zoom (2026-11-10)
- `tools/build.js` also writes `preview/header-a.html` (big logo, three rows) and `preview/header-b.html` (small logo, two rows). `LAYOUT` in build.js picks the one used for index.html.
- Fullscreen button on the map (map + layers panel); hidden in browsers without the Fullscreen API for page elements.
- Zoom goes out to 1/16 and 1/32 (tile steps 16 and 40).
- Structure icons are found on the worker threads (`js/iconjobs.js`); results come back as plain data and the page recomputes centerY() for the one hovered/clicked structure. Up to half the workers take icon batches while tiles are waiting.
- Icons are drawn from cached bitmaps (`stamp()` in app.js).
- `noise.js` reuses axis tables (2D scratch, shared 3D tables): same values, about 5x faster per mapchunk at step 40.
- Header layout A (big centered logo) is the default; the page scrolls so the header can be scrolled away. In full screen a Layers button shows/hides the panel.
- `villages.js` Model.columnHeight: the mountain test adds octaves one at a time and skips y ranges that provably cannot be solid. Same results as Mineclonia's scan (checked on 60,000 columns and 12,390 structure regions), about 9x faster.
- The header no longer scrolls away (user preferred it fixed).
- Zoomed out, common structures are left off the map and not computed (`MIN_SCALE` in app.js): treasure, mineshafts, shipwrecks, ocean ruins, ruined portals, trail ruins and trial chambers show down to 1/4; villages, temples, monuments, outposts and Nether structures down to 1/16; mansions, strongholds, spawn and End features always. Panel entries hidden by zoom are grayed and a "Zoom in" note shows on the map.
- Zoom goes out to 1/64 (tile step 80: one sample per mapchunk), where the whole world is about 970 px wide. The world edge (X/Z -30912..30927, default mapgen_limit, per docs.luanti.org World Boundaries) is outlined; nothing past it is generated or searched.
- Load ahead: when idle, workers compute the next zoom level out and a half-screen band around the view (`planAhead` in app.js). Off on touch-screen devices (`pointer: coarse`) and when the browser asks to save data.
- Saved tiles: finished tiles (gzip) and structure results are kept in IndexedDB (`antichunk` database), capped at about 100 MB with the oldest dropped first. Keys start with a fingerprint of the map code (`BUILDHASH` from tools/build.js), so a new version never reuses old results and clears them.

## Map tools (2026-11-10)
- Highlight a biome: the "Highlight" list (current dimension's biomes; overworld variants grouped by base name, sea-floor parts as "Ocean (any)") darkens everything else. Each tile keeps a small overlay canvas for the current choice (`maskFor` in app.js). Saved in the link as `hl=`.
- Clicking any empty spot opens a card: position, top block, biome, where a Nether portal there leads, and buttons.
- Waypoints: saved in this browser (localStorage `antichunk-waypoints`, per world seed), listed at the top of the layers panel, drawn as pins with their name, renamed from the card. Share links carry them (`wp=`) and opening such a link adds them.
- Nether portal helper: overworld to Nether is X/8 and Z/8 rounded with halves away from zero; Nether to overworld is times 8 (mcl_portals/portal_nether.lua). An existing portal within 16 (Nether side) or 128 (overworld side) blocks is reused, else a new one is built within 16 blocks. "Show in Nether/overworld" switches and marks the spot.
- Recent seeds: the last 10 seeds (localStorage `antichunk-seeds`) in a list next to "Show map".
- Ruler: "Measure from here" on a card, then click the end point. Shows straight-line distance, the X/Z difference, and the Nether (/8) or overworld (x8) equivalent. Esc or Clear removes it.
- Find nearest: on every card in the overworld and Nether. Searches ring by ring of placement regions on the worker threads (ahead of other work), stopping when no unsearched region could be closer. Strongholds are checked from their fixed list in order of distance. The result is selected and a ruler line drawn from the starting spot.
- Slime chunks (`js/slime.js`): Mineclonia's `is_slime_chunk` (same formula as Minecraft's, salt 987234911, 1 in 10 chunks; chunk grid uses Mineclonia's flipped z). Checked against Java's own `java.util.Random` running Minecraft's formula: 0 differences in 114,540 chunks over 6 seeds, and the drawn squares line up with the chunks (840 sample points). Panel checkbox (off by default, `slime=1` in the link), shown from zoom 1/4 in (like ruined portals), with its own panel button; chunk borders drawn from 1/2. Spot cards say whether the spot is in one.
- Save image: the download button under zoom saves the current map canvas (terrain, icons, pins, ruler) as a PNG named after seed, dimension and position.
- World settings (bottom of the layers panel): `mapgen_limit` from the world's map_meta.txt (default 31007). The edge uses Luanti's `get_mapgen_edges` for chunksize 5 (checked against the C++ for 14 limits); Nether portal folding uses Mineclonia's MAP_EDGE = floor(limit/80)*80-48. Saved per seed in localStorage (`antichunk-limits`) and as `limit=` in links. Changing it re-reads structures so ones past the new edge drop out.
- About card links to Luanti (luanti.org), Mineclonia on ContentDB, and Mineclonia's source on Codeberg.
- Version 0.1.22 (footer and About). North arrow on the map (bottom right). About ends with a GitHub link (Octicons mark, MIT) "Antichunk 0.1.22, crafted by buddyholly"; `PROJECT_URL` in app.js is the placeholder for its address.
