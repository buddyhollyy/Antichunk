#!/usr/bin/env python3
"""Reads Mineclonia's biome definitions (mods/MAPGEN/mcl_biomes/init.lua) as
text and writes js/biomes-data.js with the fields Luanti uses to pick a
biome. It does not run any Lua: it parses the core.register_biome({...})
blocks of register_biomes() and adds the deep ocean / underground biomes
that its final loop creates, in the same order Mineclonia registers them.

Usage: python3 tools/extract_biomes.py <path to mineclonia checkout>
"""
import json, os, re, sys

src_root = sys.argv[1]
text = open(os.path.join(src_root, 'mods/MAPGEN/mcl_biomes/init.lua'), encoding='utf-8').read()

# Values from mcl_init (normal, non-singlenode, non-superflat worlds) and the
# constants at the top of mcl_biomes.
MAPGEN_EDGE_MAX = None  # filled below
CONST = {'OCEAN_MIN': -15, 'DEEP_OCEAN_MAX': -16, 'DEEP_OCEAN_MIN': -31,
         'mcl_vars.mg_overworld_min': -128, 'mcl_vars.mg_overworld_min_old': -128}

# mcl_vars.mg_overworld_max = mapgen_edge_max (mcl_init), for default
# chunksize 5 and mapgen_limit 31007 (Luanti default, settingtypes.txt).
def mapgen_edge_max(chunksize=5, mapgen_limit=31007, blocksize=16, max_limit=31007):
    import math
    mapgen_limit_b = math.floor(min(mapgen_limit, max_limit) / blocksize)
    mapgen_limit_min = -mapgen_limit_b * blocksize
    mapgen_limit_max = (mapgen_limit_b + 1) * blocksize - 1
    central_chunk_offset = -math.floor(chunksize / 2)
    chunk_size_in_nodes = chunksize * blocksize
    central_chunk_min_pos = central_chunk_offset * blocksize
    central_chunk_max_pos = central_chunk_min_pos + chunk_size_in_nodes - 1
    ccfmax = central_chunk_max_pos + blocksize
    numcmax = math.floor(max(mapgen_limit_max - ccfmax, 0) / chunk_size_in_nodes)
    return central_chunk_max_pos + numcmax * chunk_size_in_nodes

# Check that mcl_init still computes mapgen_edge_max the way we assume.
init_src = open(os.path.join(src_root, 'mods/CORE/mcl_init/init.lua'), encoding='utf-8').read()
assert 'mcl_vars.mapgen_edge_max = central_chunk_max_pos + numcmax * mcl_vars.chunk_size_in_nodes' in init_src
CONST['mcl_vars.mg_overworld_max'] = mapgen_edge_max()

start = text.index('local function register_biomes()')
end = text.index('local function register_dimension_biomes()')
body = text[start:end]

def blocks(s):
    """Yield the text of each register_biome({ ... }) table, in order."""
    for m in re.finditer(r'core\.register_biome\s*\(\s*\{', s):
        i = m.end() - 1
        depth = 0
        for j in range(i, len(s)):
            c = s[j]
            if c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    yield m.start(), s[i + 1:j]
                    break

def top_fields(tbl):
    """Top-level 'key = value' pairs of a Lua table body (skips nested tables)."""
    out, depth, cur = {}, 0, ''
    tbl = re.sub(r'--\[\[.*?\]\]', '', tbl, flags=re.S)
    tbl = re.sub(r'--[^\n]*', '', tbl)
    for c in tbl:
        if c in '{(': depth += 1
        if c in '})': depth -= 1
        if c == ',' and depth == 0:
            add(out, cur); cur = ''
        else:
            cur += c
    add(out, cur)
    return out

def add(out, item):
    item = re.sub(r'--[^\n]*', '', item).strip()
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$', item, re.S)
    if m: out[m.group(1)] = m.group(2).strip()

def num(expr):
    expr = expr.strip()
    m = re.match(r'^(-?\d+(?:\.\d+)?)$', expr)
    if m: return float(m.group(1)) if '.' in expr else int(expr)
    m = re.match(r'^([A-Za-z_.]+)\s*([+-])\s*(\d+)$', expr)
    if m:
        base = CONST[m.group(1)]
        return base + int(m.group(3)) if m.group(2) == '+' else base - int(m.group(3))
    if expr in CONST: return CONST[expr]
    raise ValueError('cannot evaluate ' + expr)

def string(expr):
    m = re.match(r'^"([^"]*)"$', expr.strip())
    return m.group(1) if m else None

loop_at = body.index('for i=1, #overworld_biomes do')
biomes = []
for pos, tbl in blocks(body):
    if pos > loop_at:
        continue  # the loop's three templates are expanded below
    f = top_fields(tbl)
    b = {'name': string(f['name'])}
    for k in ('heat_point', 'humidity_point', 'y_min', 'y_max', 'vertical_blend', 'weight'):
        if k in f: b[k] = num(f[k])
    for k in ('min_pos', 'max_pos'):
        if k in f: raise ValueError('min_pos/max_pos not supported: ' + b['name'])
    for k in ('node_top', '_mcl_biome_type'):
        if k in f and string(f[k]) is not None: b[k] = string(f[k])
    if '_mcl_palette_index' in f: b['palette'] = num(f['_mcl_palette_index'])
    biomes.append(b)

# Expand the final loop over overworld_biomes.
lst = re.search(r'local overworld_biomes = \{(.*?)\n\t\}', body, re.S).group(1)
overworld = re.findall(r'"([^"]+)"', lst)
loop = body[loop_at:]
assert loop.count('core.register_biome') == 3, 'loop changed'
assert 'y_min = DEEP_OCEAN_MIN,' in loop and 'y_max = DEEP_OCEAN_MAX,' in loop
assert 'vertical_blend = 5,' in loop
by_name = {b['name']: b for b in biomes}
for name in overworld:
    base = by_name[name]
    common = {'heat_point': base['heat_point'], 'humidity_point': base['humidity_point'],
              '_mcl_biome_type': base.get('_mcl_biome_type')}
    biomes.append(dict(name=name + '_deep_ocean', y_min=CONST['DEEP_OCEAN_MIN'],
                       y_max=CONST['DEEP_OCEAN_MAX'], vertical_blend=5, **common))
    biomes.append(dict(name=name + '_underground', y_min=CONST['mcl_vars.mg_overworld_min_old'],
                       y_max=CONST['DEEP_OCEAN_MIN'] - 1, **common))
    biomes.append(dict(name=name + '_deep_underground', y_min=CONST['mcl_vars.mg_overworld_min'],
                       y_max=CONST['mcl_vars.mg_overworld_min_old'], **common))

# Nether biomes, registered after the overworld by register_dimension_biomes()
# (so their engine ids follow).  The Nether layer starts at Y -29067 in
# non-singlenode worlds such as v7 (mcl_init: mg_nether_min when
# enable_mcl_levelgen is false).
assert 'mcl_vars.mg_nether_min = -29067' in init_src
assert 'mcl_vars.mg_nether_max = mcl_vars.mg_nether_min + 128' in init_src
CONST['mcl_vars.mg_nether_min'] = -29067
CONST['mcl_vars.mg_nether_max'] = -29067 + 128
dstart = text.index('local function register_dimension_biomes()')
dbody = text[dstart:text.index('--[[ THE END', dstart)]
nether = []
for pos, tbl in blocks(dbody):
    f = top_fields(tbl)
    b = {'name': string(f['name']), 'dimension': 'nether'}
    for k in ('heat_point', 'humidity_point', 'y_min', 'y_max', 'vertical_blend', 'weight'):
        if k in f: b[k] = num(f[k])
    if '_mcl_biome_type' in f: b['_mcl_biome_type'] = string(f['_mcl_biome_type'])
    nether.append(b)
assert [b['name'] for b in nether] == ['Nether', 'SoulsandValley', 'CrimsonForest', 'WarpedForest', 'BasaltDelta'], nether
biomes.extend(nether)

# Fill engine defaults (src/mapgen/mg_biome.h).
for b in biomes:
    b.setdefault('vertical_blend', 0)
    b.setdefault('weight', 1.0)
    b.setdefault('y_min', -31007)
    b.setdefault('y_max', 31007)

out_path = os.path.join(os.path.dirname(__file__), '..', 'js', 'biomes-data.js')
with open(out_path, 'w') as fh:
    fh.write('// Generated by tools/extract_biomes.py from Mineclonia\'s mcl_biomes/init.lua\n')
    fh.write('// (Mineclonia is GPL-3.0). Overworld biomes in registration order.\n')
    fh.write('(function (root) {\n  const data = ')
    fh.write(json.dumps({'overworld': overworld, 'biomes': biomes}, indent=1))
    fh.write(';\n  if (typeof module !== "undefined" && module.exports) module.exports = data;\n')
    fh.write('  else root.MclBiomes = data;\n})(typeof self !== "undefined" ? self : this);\n')
print(len(biomes), 'biomes;', 'mg_overworld_max =', CONST['mcl_vars.mg_overworld_max'])
