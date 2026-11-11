# Builds js/node-colors.js: one map color for each Mineclonia node, used to
# draw a player's saved world.  Each color is the average of the node's
# texture (its top texture where the definition lists one).  Grass, leaves
# and other biome-tinted nodes also get the palette that the game colors
# them with (param2 picks the palette entry).
#
# Run with: python3 tools/node_colors.py <path to a Mineclonia checkout>
# Needs Pillow and NumPy.  Reads the Lua files as text; nothing is run.
import sys, os, re, json
import numpy as np
from PIL import Image

root = sys.argv[1]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'js', 'node-colors.js')

pngs = {}
for d, _, fs in os.walk(root):
    for f in fs:
        if f.endswith('.png'):
            pngs.setdefault(f, os.path.join(d, f))

def avg(fn):
    p = pngs.get(fn)
    if not p:
        return None
    im = np.asarray(Image.open(p).convert('RGBA'), float)
    im = im[:min(im.shape[0], im.shape[1])]  # first frame of an animation
    a = im[..., 3] > 128
    if not a.any():
        return None
    return [int(round(v)) for v in im[a][:, :3].mean(0)]

def palette(fn):
    p = pngs.get(fn)
    if not p:
        return None
    P = np.asarray(Image.open(p).convert('RGB')).reshape(-1, 3)[:256]
    return ''.join('%02x%02x%02x' % tuple(int(v) for v in c) for c in P)

# Node definitions written out in the source: name -> (texture, palette, color)
defs = {}
reg = re.compile(r'register_node\(\s*"([^"]+)"')
for d, _, fs in os.walk(root):
    for f in fs:
        if not f.endswith('.lua'):
            continue
        s = open(os.path.join(d, f), errors='ignore').read()
        for m in reg.finditer(s):
            body = s[m.end():m.end() + 3000]
            nxt = reg.search(body)
            body = body[:nxt.start()] if nxt else body
            t = re.search(r'tiles\s*=\s*\{\s*\{?\s*(?:name\s*=\s*)?"([^"^]+\.png)', body)
            pal = re.search(r'palette\s*=\s*"([^"]+\.png)"', body)
            defs[m.group(1).lstrip(':')] = (t.group(1) if t else None, pal.group(1) if pal else None)

# Woods are registered through mcl_trees.register_wood with textures named
# per wood (mods/ITEMS/mcl_core/nodes_trees.lua and the wood mods).  Leaves
# use the leaves palette except cherry and pale oak (palette = "").
WOODS = {
    'oak': ('default_leaves.png', 'default_tree_top.png', 'default_wood.png'),
    'dark_oak': ('mcl_core_leaves_big_oak.png', 'mcl_core_log_big_oak_top.png', 'mcl_core_planks_big_oak.png'),
    'jungle': ('default_jungleleaves.png', 'default_jungletree_top.png', 'default_junglewood.png'),
    'spruce': ('mcl_core_leaves_spruce.png', 'mcl_core_log_spruce_top.png', 'mcl_core_planks_spruce.png'),
    'acacia': ('default_acacia_leaves.png', 'default_acacia_tree_top.png', 'default_acacia_wood.png'),
    'birch': ('mcl_core_leaves_birch.png', 'mcl_core_log_birch_top.png', 'mcl_core_planks_birch.png'),
    'cherry_blossom': ('mcl_cherry_blossom_leaves.png', 'mcl_cherry_blossom_log_top.png', 'mcl_cherry_blossom_planks.png'),
    'pale_oak': ('mcl_pale_oak_leaves.png', 'mcl_pale_oak_log_top.png', 'mcl_pale_oak_planks.png'),
    'mangrove': ('mcl_mangrove_leaves.png', 'mcl_mangrove_log_top.png', 'mcl_mangrove_planks.png'),
}
for w, (l, t, p) in WOODS.items():
    pal = None if w in ('cherry_blossom', 'pale_oak') else 'mcl_core_palette_leaves.png'
    defs['mcl_trees:leaves_' + w] = (l, pal)
    defs['mcl_trees:tree_' + w] = (t, None)
    defs['mcl_trees:wood_' + w] = (p, None)
    defs['mcl_fences:%s_fence' % w] = (p, None)
    defs['mcl_doors:trapdoor_' + w] = (p, None)
    defs['mcl_stairs:stair_' + w] = (p, None)
    defs['mcl_stairs:slab_' + w] = (p, None)
defs['mcl_trees:leaves_azalea'] = ('mcl_lush_caves_azalea_leaves.png', None)
defs['mcl_trees:leaves_azalea_flowering'] = ('mcl_lush_caves_azalea_leaves_flowering.png', None)
defs['mcl_mushrooms:brown_mushroom_block'] = ('mcl_mushrooms_mushroom_block_skin_brown.png', None)
defs['mcl_mushrooms:red_mushroom_block'] = ('mcl_mushrooms_mushroom_block_skin_red.png', None)
defs['mcl_minecarts:golden_rail'] = ('mcl_minecarts_rail_golden.png', None)
defs['mcl_minecarts:rail'] = ('default_rail.png', None)
defs['mcl_core:dirt_with_grass_snow'] = ('default_snow.png', None)
# A few more that are registered through helpers under other names.
for nm, tex in {
    'mcl_core:snow': 'default_snow.png', 'mcl_farming:pumpkin': 'farming_pumpkin_top.png',
    'mcl_farming:melon': 'farming_melon_top.png', 'mcl_chests:chest': 'mcl_chests_normal.png',
    'mcl_campfires:campfire': 'mcl_campfires_log.png', 'mcl_furnaces:furnace': 'default_furnace_top.png',
    'mcl_smoker:smoker': 'smoker_top.png', 'mcl_dripstone:dripstone': 'pointed_dripstone_base.png',
    'mcl_dripstone:dripstone_block': 'dripstone_block.png', 'mcl_vaults:vault': 'mcl_vaults_vault_top.png',
    'mcl_amethyst:amethyst_bud': 'mcl_amethyst_amethyst_bud_medium.png', 'mcl_cocoas:cocoa': 'mcl_cocoas_cocoa_stage_2.png',
    'mcl_redstone:redstone': 'redstone_redstone_block.png', 'mcl_panes:pane_natural': 'default_glass.png',
    'mcl_deepslate:deepslatebrickswall': 'mcl_deepslate_bricks.png', 'mcl_copper:copper_cut': 'mcl_copper_block_cut.png',
    'mcl_repeaters:repeater': 'mcl_repeaters_repeater_off.png',
}.items():
    defs[nm] = (tex, None)

# Dye-colored families (mcl_colorblocks, mcl_wool, mcl_core glass, mcl_panes,
# mcl_beds), with the texture names their mods use.
WOOL_TEX = {'light_blue': 'mcl_wool_light_blue', 'grey': 'wool_dark_grey', 'silver': 'wool_grey',
            'green': 'wool_dark_green', 'lime': 'mcl_wool_lime', 'purple': 'wool_violet'}
dyes = sorted(f[len('hardened_clay_stained_'):-4] for f in pngs if f.startswith('hardened_clay_stained_'))
for c in dyes:
    defs['mcl_colorblocks:hardened_clay_' + c] = ('hardened_clay_stained_%s.png' % c, None)
    for kind in ('concrete', 'concrete_powder', 'glazed_terracotta'):
        defs['mcl_colorblocks:%s_%s' % (kind, c)] = ('mcl_colorblocks_%s_%s.png' % (kind, c), None)
    wool = WOOL_TEX.get(c, 'wool_' + c) + '.png'
    for nm in ('mcl_wool:' + c, 'mcl_wool:%s_carpet' % c, 'mcl_beds:bed_%s_top' % c, 'mcl_beds:bed_%s_bottom' % c,
               'mcl_stairs:stair_wool_' + c, 'mcl_stairs:slab_wool_' + c):
        defs[nm] = (wool, None)
    for nm in ('mcl_core:glass_' + c, 'mcl_panes:pane_' + c, 'mcl_panes:pane_%s_flat' % c):
        defs[nm] = ('mcl_core_glass_%s.png' % c, None)

def guess(nm):
    mod, short = nm.split(':', 1)
    for c in (mod + '_' + short + '.png', short + '.png', 'default_' + short + '.png',
              'mcl_core_' + short + '.png', short + '_top.png', mod + '_' + short + '_top.png'):
        if c in pngs:
            return c
    return None

# Nodes registered through helper functions don't show up above.  Many
# of them are named like their texture (mcl_copper_block_cut.png ->
# mcl_copper:block_cut), so add those names too, leaving out item, mob and
# effect pictures.
mods = set()
for d, ds, _ in os.walk(os.path.join(root, 'mods')):
    mods.update(ds)
NOT_NODE = re.compile(r'(_inv|_item|item_|particle|_dye|armor|chestplate|helmet|leggings|boots|_overlay|_mask|_side|_bottom|_front|_back|_detail|_anim|_icon|_hud|_gui|_inventory)')
for f in pngs:
    stem = f[:-4]
    for m in mods:
        if stem.startswith(m + '_') and len(stem) > len(m) + 1:
            nm = m + ':' + stem[len(m) + 1:]
            if nm not in defs and not NOT_NODE.search(stem) and not stem.startswith('mobs_'):
                defs[nm] = (f, None)

colors, pals = {}, {}
palettes = {}
for nm, (tex, pal) in sorted(defs.items()):
    if ':' not in nm:
        continue
    c = avg(tex) if tex else None
    if c is None:
        g = guess(nm)
        c = avg(g) if g else None
    if c is None:
        continue
    colors[nm] = '%02x%02x%02x' % tuple(c)
    if pal and pal in pngs:
        key = pal[:-4]
        if key not in palettes:
            palettes[key] = palette(pal)
        pals[nm] = key

head = ('// Map colors for Mineclonia nodes, made by tools/node_colors.py from\n'
        '// Mineclonia\'s textures (mostly from Pixel Perfection by XSSheep and\n'
        '// Pixel Perfection Legacy, CC BY-SA 4.0; see Mineclonia\'s LEGAL.md).\n'
        '// c: node -> "rrggbb" (texture average); p: node -> name of the palette in\n'
        '// pal that param2 picks a tint from (multiplied in).\n')
with open(out, 'w') as f:
    f.write(head + 'const NODE_COLORS = ' + json.dumps({'c': colors, 'p': pals, 'pal': palettes}, separators=(',', ':')) + ';\n')
print('wrote', out, len(colors), 'nodes,', len(pals), 'tinted,', len(palettes), 'palettes')
