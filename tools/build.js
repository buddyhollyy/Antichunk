// Builds index.html: one self-contained file (no server needed), made from
// src/page.html with the scripts in js/ pasted in.
// Run with: node tools/build.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('src/page.html');
const parts = {
  NOISE: read('js/noise.js'),
  V7: read('js/v7.js'),
  FLAT: read('js/flat.js'),
  V5: read('js/v5.js'),
  VALLEYS: read('js/valleys.js'),
  CARPATHIAN: read('js/carpathian.js'),
  WORKER: read('js/worker.js'),
  APP: read('js/app.js'),
  BIOMEDATA: read('js/biomes-data.js'),
  BIOMEGEN: read('js/biomegen.js'),
  BIOMECOLORS: read('js/biome-colors.js'),
  VILLAGES: read('js/villages.js'),
  PORTALS: read('js/portals.js'),
  TEMPLES: read('js/temples.js'),
  OCEAN: read('js/ocean.js'),
  LANDMARKS: read('js/landmarks.js'),
  STRONGHOLDS: read('js/strongholds.js'),
  SLIME: read('js/slime.js'),
  SPAWN: read('js/spawn.js'),
  NETHER: read('js/nether.js'),
  END: read('js/end.js'),
  ICONJOBS: read('js/iconjobs.js'),
  NODECOLORS: read('js/node-colors.js'),
  ZSTD: read('js/zstd-wasm.js'),
  WORLDIMPORT: read('js/worldimport.js'),
  FAVICON: 'data:image/x-icon;base64,' + fs.readFileSync(path.join(root, 'logo/favicon.ico')).toString('base64'),
  LOGO: read('logo/lockup.svg').replace(/ width="\d+" height="\d+"/, '').replace(/ xmlns:c2pa="[^"]*"/, '').trim(),
};
// Fingerprint of the code that decides what the map shows; saved tiles in
// the browser are only reused by a page with the same fingerprint.
parts.BUILDHASH = require('crypto').createHash('sha256').update(
  ['noise', 'v7', 'v5', 'flat', 'valleys', 'carpathian', 'biomes-data', 'biomegen', 'biome-colors', 'worker', 'end', 'nether', 'villages', 'portals',
    'temples', 'ocean', 'landmarks', 'strongholds', 'iconjobs'].map((f) => read('js/' + f + '.js')).join('\n')).digest('hex').slice(0, 12);
for (const [name, code] of Object.entries(parts)) {
  if (code.includes('</script')) throw new Error(name + ' contains </script');
  html = html.replaceAll('/*@' + name + '@*/', () => code);
}
// The header layout: index.html uses LAYOUT; preview pages show each choice.
const LAYOUT = 'a';
fs.writeFileSync(path.join(root, 'index.html'), html.replace('/*@LAYOUT@*/', LAYOUT));
console.log('wrote index.html (' + html.length + ' bytes)');
fs.mkdirSync(path.join(root, 'preview'), { recursive: true });
for (const l of ['a', 'b']) fs.writeFileSync(path.join(root, 'preview', 'header-' + l + '.html'), html.replace('/*@LAYOUT@*/', l));
