![Antichunk](logo/lockup.svg)

# Antichunk

Antichunk is a seed map for [Luanti](https://www.luanti.org/) worlds made 
with [Mineclonia](https://content.luanti.org/packages/ryvnf/mineclonia/). 
It is a webpage that shows the terrain of a Luanti world (v7 mapgen, default
settings) from its seed, like Chunkbase does for Minecraft.

**Live demo: [buddyhollyy.github.io/Antichunk](https://buddyhollyy.github.io/Antichunk/)**

## How to open it

Open `index.html` in a web browser (double-click it). It needs no server and
no internet connection. Type the seed exactly as it was typed when the world
was created, then press "Show map". You can find the seed in game by pressing
'F5' on the keyboard. Drag to move, use the mouse wheel or the + / − buttons to 
zoom (or pinch zoom on touch screens). The address bar keeps the seed and
position, so a bookmark brings you back to the same view.

Click any icon on the map to select it. A card displays a short description of the
item (with a link to its Minecraft Wiki article), shows its position, how 
accurate that position is, and the `/locate` command to check it in game. At the
bottom are buttons to copy locate and teleport commands to this item. 

## Accuracy

The JavaScript output was checked against Luanti's own C++ noise code
compiled from source. In every column tested, the surface height matched
exactly, and so did the biome (the biome check used a copy of Luanti's
biome-choice function with the real noise and random-number code).

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

## Build

index.html is built from the files in src/ and js/ by running node tools/build.js.
