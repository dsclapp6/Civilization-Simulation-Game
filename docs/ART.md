# Millennia — Art Guide

Authoritative art direction for everything rendered (supersedes ARCHITECTURE §14 where they differ).
Implementation: `src/assets/**` (library), reviewed in the gallery (`npm run dev` → `?mode=gallery`),
screenshots in `docs/art/` (`node tools/gallery-shots.mjs`).

## 1. The look in one paragraph

Stylized low-poly, **flat-shaded, vertex-coloured, no textures**. Chunky, slightly organic forms:
thatch that bulges and sags, ridges that dip, eaves that overhang and throw deep shadow lines. A warm,
natural, slightly desaturated palette (honey stone, cream daub, dark oak, golden thatch, weathered
terracotta, slate blue) under a warm sun and a cool blue sky fill. Real medieval vernacular from
England and its neighbours, with each culture recognisable from a distance by roof material, wall
treatment and silhouette. Charm comes from **silhouette first, colour second, detail last**.

## 2. Style rules

1. **Silhouette first.** Every building must read at 150 m from roof shape alone: half-hips and
   chimneys (anglo), steep gables and spires (franc), helms and red tile (teuton), turf and crossed
   gable boards (norse), low roped hips (gael), white walls under slate (cymric).
2. **Big roofs.** Roofs are the dominant mass. Overhangs 0.3–0.5 m, thick edges, visible ridge caps.
   Soft materials (thatch, heather, turf) bulge ~0.1–0.2 m and sag at the ridge; hard materials
   (tile, slate, stone slate, shingle) show stepped course lips.
3. **Faceted, never noisy.** Flat shading with *large* faces; per-face brightness jitter ±3–5 %.
   No high-frequency geometry: wall details are flush decal quads (timber, frames, quoins, doors).
4. **Grounded.** Every building has a plinth sunk to −0.8 m, vertex-AO darkening in the first 0.9 m,
   and a worn-earth yard around it (renderer: `Ground.Yard`).
5. **Organic irregularity is deterministic.** All variation comes from `seed`/position hashes; the
   same request always produces the same model (4 seed buckets per kind/level/culture).
6. **Do not** use pure black, pure white or saturated primaries on large surfaces. Darkest wood
   `#3e2a1c`, brightest limewash `#efe9da`. Saturated colour is reserved for small accents: doors,
   shutters, banners, market awnings, flowers, glowing windows.

## 3. Units, scale, proportions

1 unit = 1 m; buildings face **local +z** (doors), origin at footprint centre on the ground.
Footprints come from `src/content/buildings.json`; all geometry stays within w×d (+0.15 m test
tolerance), animated parts excepted (windmill sails sweep beyond).

| Reference | Size |
|---|---|
| Adult / door | 1.55–1.85 m / 0.95 × 1.95 m (barn doors 2.6 × 2.9) |
| Cottage eaves / ridge | 2.6–2.9 m / 5.5–7 m |
| Storey (timber / stone) | 2.4–2.8 m / 3.0 m; jetties 0.35–0.5 m |
| Townhouse, 3 storeys | ≈ 12 m |
| Parish church tower | 13.5 m (L2), 17.5 m (L3) + spire 12 m (franc/teuton/norse) |
| Stone keep | 17 / 20 / 23 m + turrets |
| Cathedral | nave 22 m, crossing tower 44 m, spire top ≈ 72 m |
| Post mill | buck 4.4–5 m on a 3.2–3.6 m post, sails 6.2–7 m radius |
| Oak / beech / pine | 14 / 17 / 17 m at scale 1 |

## 4. Palette and colour

* Author in **sRGB hex**; `MeshBuilder` converts to linear for vertex colours. Shared terrain/sky/UI
  colours live in `src/assets/palette.ts` (tuned: grass `#74a04c`, meadow `#8aae56`, roof tile
  `#9b5a3f`, night ambient `#3a4c80`). Architecture colours live in `src/assets/buildings/style.ts`.
* Culture styles (`STYLES`):

| Culture | Homes (L1→L3) | Roofs | Churches / castles |
|---|---|---|---|
| anglo | cream daub, cruck → box → close studding | thatch (half-hip, block-cut ridge) → peg tile | honey limestone, lead roofs, crenellated towers, pinnacles |
| franc | white render → colombage → pale ashlar | thatch with iris ridge → flat tile → slate, 57° | pale Caen stone, slate, octagonal broach spires, round towers with cones |
| teuton | Fachwerk (oxblood timber, St Andrew crosses) | thatch → red tile, 55° | red sandstone, Rhenish helm spires, pyramid tower roofs |
| norse | tarred vertical planks on stone footing | turf with grass tufts → shingle, crossed gable boards | dark timber, shingled spires |
| gael | grey rubble blackhouses | roped heather thatch with hanging stones → slate, crow-stepped gables | grey stone, Irish round tower (church L3) |
| cymric | whitewashed rubble, big gable chimneys | thatch → Welsh slate | grey stone, double bellcotes, round towers |

## 5. Materials (shared, one instance each)

| Channel | Material | Notes |
|---|---|---|
| Opaque | `MeshStandardMaterial` vertexColors, flatShading, roughness 0.9, metalness 0 | Patched: snow on up-facing faces (`aSurf.x`), seasonal grass tint (`aSurf.y`, turf roofs/mounds). DoubleSide twin used only for construction/damage states. |
| Window | Standard, dark glass `#1d1814`, roughness 0.5 | Emissive = vertex colour (warm `#ffb057` × per-window 0.18–1.0) × level × night × 1.15 (amber, not tone-mapped to white). 5 shared lit levels (`setLit`). |
| Glow | `MeshBasicMaterial` ×1.9 with flicker | Forges, kilns, bloomeries, campfires. Always on (bloom-friendly). |
| Cloth | Standard, DoubleSide | Flags, awnings, tents, tenter cloth: travelling wave from `aSway`; matching depth material. |
| Water | Standard, roughness 0.12 | Mill races, wells, vats; slow shimmer. |
| Vegetation | `MeshLambertMaterial`, one per scatter kind (shared program) | Wind sway, seasonal tint (2 tints mixed per instance), leaf fall/bud burst (faces shrink into clump centres), blossom, fruit, petals, snow. Thin plants (`soft`) use smooth up-bent normals so they light like the ground. |

All materials take fog; none needs textures. Per-instance variation is a hash of the instance
position (no `instanceColor` needed; if the renderer sets one it multiplies in).

## 6. What the renderer must provide

* `WebGLRenderer`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`,
  exposure **1.0**. No `scene.environment` (or ≤ 0.3 intensity) — Lambert vegetation ignores it.
* **Day (game renderer, `src/render/sky/atmosphere.ts`):** sun `DirectionalLight` 2.9 at noon
  (colour `palette.sun.day`), keeping ~0.92× and turning `palette.sun.dusk` near the horizon;
  `HemisphereLight` **1.6** (sky `#bfd9ef`, warm ground bounce `#8f7b58`), warmed toward `#e8b896` /
  `#a8764a` at golden hour, plus a **shadowless sky fill** `DirectionalLight` 0.7 (`#c9dcf0`, bluer at
  golden hour) from the sky opposite the sun, 37° up. Under three's physically based lights a Lambert
  face reflects albedo × E / π, so the old hemisphere 0.9 left every wall out of the sun at a tenth of
  the sunlit brightness and streets read grey at noon; the fill keeps shaded walls at roughly a third of
  sunlit ground and gives them form. Exposure rises ~12 % at golden hour. (The gallery stage still uses
  the older 3.0 / 0.9 numbers.)
* **Night (moonlit blue):** moon `DirectionalLight` **0.9** `palette.sun.moon`; hemisphere
  0.27 + **0.75** (sky `palette.ambient.night #3a4c80`, ground `#1e2433`), no sky fill. Lit homes and
  inns throw a warm additive light pool on the ground at their doors (renderer, one draw call).
* **Optional night grade** (post): desaturate ~30 % and lift shadows toward `#3a4c80` scaled by
  `nightLight`, leaving emissive windows/fires untouched — sells moonlight on grass and fields.
* **Shadows:** PCF, 2048–4096 map over the near view, `bias ≈ -0.0004`, `normalBias 0.02–0.05`.
  Models are closed (roof slabs have soffits) so default back-face shadow rendering works.
  For instanced vegetation/crops set `mesh.customDepthMaterial = kit.depthMaterial`.
* **Fog:** linear/exp fog in `palette.fog.*`; atmospheric perspective is part of the look.
* **Per frame:** `library.setEnvironment({ time, season, seasonProgress, snowCover, windX, windZ,
  nightLight })` **before** rendering (it drives every shared uniform including the FX clock);
  `asset.update(t, dt)` for visible buildings (mill wheels/sails, wind-facing post mills, flags
  streaming downwind, swinging signs); `asset.setLit(occupied ? 1 : 0)` (multiplied by
  `nightLight`). Optional bloom (threshold ≈ 1) makes windows and forges sing at night.
* **FX anchors:** emit `hearth_smoke` at `asset.smokePoints` while occupied (≈ 1 event / 0.35 s),
  `asset.emitters` at their `rate` (sparks, splash), `fire` at `asset.firePoints` when burning.
  Props expose `object.userData.emitters`.

## 7. Seasons and weather

Phenology tables in `src/assets/vegetation/phenology.ts` map (season, progress) → tint A/B,
leafiness, blossom, fruit for each plant type:
spring = bud burst, fresh yellow-greens, apple/hawthorn blossom; summer = deep greens, wildflowers;
autumn = birch gold, beech copper, oak russet, bracken rust, haws/apples/blackberries; winter =
bare deciduous trees (beech/oak keep a few brown leaves), conifers green with snow, grass dulled.
`snowCover` whitens up-facing faces of buildings, vegetation and rocks with a noisy edge; turf roofs
and grassy mounds follow the grass tint. Wind drives vegetation sway, crop waves, cloth, flags,
smoke drift and windmill speed.

## 8. Buildings

* **Every kind** in `buildings.json` has a recipe (`src/assets/buildings/recipes/*`), every level is
  visibly distinct (size, storeys, chimneys, porches, outbuildings, better roofs, towers/spires).
* **Construction** (`construction < 1`, 12 cached steps whose breaks are the sim's stages — pegs < 0.08 ≤
  footings < 0.3 ≤ frame < 0.75 ≤ roof < 1, so the model always shows the stage the site card names; see §14):
  pegs, string lines and lime marks → trenches with spoil → the ground works heaped up whole (plinths,
  platforms, a motte's mound) → timber frame rising ahead of the infill → walls (ragged course top) →
  rafters → roof laid from the eaves up → doors/windows. Walls whose eaves stand ≥ 4.2 m (or anything with
  walls 10 m up) get a full scaffold (standards, ledgers, braces, boarded lifts, a hoist); lower ones a ladder and
  trestles; earthworks (quarry, clay pit, mine, charcoal mound, motte, salt pans) none. Moving parts are
  built with the rest (a post mill's buck, a mill wheel); sails go on at the end. The materials lying at a site are
  world props from the sim's site view, not part of the model.
* **Damage** (4 cached steps): soot and char (timber chars black), roof holes revealing charred
  rafters, smashed dark windows, ragged partial collapse at ≥ 0.5, rubble and fallen beams, ruin at 1.
* **Animated parts:** watermill/fulling-mill wheels, post-mill buck turning into the wind with
  spinning sails, quarry treadwheel, swinging inn/smithy signs, quintain arm, flags/pennants.
* **Wall segments** (`palisade` 4 m, `wall` 6 m) run along local x, outside on +z, and tile
  seamlessly (stake/merlon/course periods divide the segment length). A **breach** (`view.forts()`) batters the
  crest below 0.5 and opens a gap of rubble from 0.5 (the whole segment a heap at 1); a **gatehouse** draws its gate
  open, shut (leaves closed and barred, portcullis down) or broken (a leaf hanging, one down, the portcullis jammed
  with bent bars) — both are part of the cached model (request `gate`/`breach`).
* **Water side:** watermills, fulling mills and tanneries carry their own raised mill race / pits
  behind the building (local −z); docks put the river on local −z.
* **LOD:** (the renderer cross-fades a swap with a 0.6 s screen-door dither; vegetation bands fade
  per instance over 18 m) `request.lod` 0 ≤ 120 m (all detail), 1 ≤ 400 m (no yard decor, coarse roofs, corner posts
  only), 2 beyond (silhouette, lit windows kept for night views).

## 9. Vegetation, crops, props

* Trees: trunk + limbs + 5–7 faceted canopy clumps (LOD0), 2 clumps (LOD1), octahedron + spike
  (LOD2). Conifers: tiered cones (spruce), clouded flat tops on a red trunk (Scots pine).
  Scale 1 = typical adult. One geometry + one material per kind/LOD, instancing-ready.
* Crops: 12 kinds × 4 stages, one clump ≈ 0.5 m, plant every ~0.5 m in rows; colours baked per stage
  (green → gold), drooping barley, oat panicles, blue flax, rosettes, bulbs; fallow = grass, docks,
  poppies.
* Props: 53 kinds, origin at base centre, front +z; fences (2–3 m) tile along x. Compact low-poly
  variants (`decorInto`) dress building yards inside the footprint. Piles (`PILE_KINDS`) take a size 1–8 and grow
  with it (woodpile, sacks, stone, logs, planks, brick hacks, clay, salt, trunks, squared timber, straw bundles).

## 10. FX and projectiles

* FX: one ring buffer each of alpha-blended (4096) and additive (2048) billboards → **2 draw calls**.
  Motion (drag, gravity/buoyancy, wind) is evaluated in the vertex shader from spawn data; shapes:
  soft puff, droplet, tumbling chip, velocity-aligned spark streak, flame teardrop. Hearth smoke is a
  dense blue-grey plume (α 0.62, 0.5 → 3.6 m, buoyant, a puff every ~0.28 s) that dims to ~45 % at night.
  Steam (quenching, brine boiling) is a quick white burst that rises fast, billows out and is gone in ~2 s.
* Projectiles: arrow / bolt / stone / javelin, one InstancedMesh each (≤ 4 draw calls, hidden when
  empty), oriented by velocity, origin just behind the tip so stuck projectiles show their shaft.

## 11. Budgets (LOD0, measured)

| Asset | Budget | Measured |
|---|---|---|
| Typical cottage (L1–L2) | ≤ 800 | 415–802 |
| Any building | ≤ 3 000 | average 1 339; largest ordinary (manor L3) ≤ 2 908 |
| Abbey church, cloister (monumental) | ≤ 6 500 | ≤ 6 400 / ≤ 5 900 |
| Cathedral | ≤ 12 000 | 6 094–7 826 |
| Tree LOD 0/1/2 | ≤ 300 / 60 / 12 | oak 234/48/11, spruce 96/38/11 |
| Crop clump | ≤ 120 | 5–104 |
| Draw calls per building | 1 body + windows (+ glow/cloth/water/animated parts/flags) | 2–4 typical |
| New works (slaughterhouse, clay pit, salt pans, lumber camp, gaol) | ≤ 2 600 | 877–2 182 |
| Siege works (ladder 8 m, ram, mantlet, trebuchet, mangonel) | ≤ 3 000 | 300 / 633 / 228 / 322 / 236 |
| Deposit in view (pieces + stain + glints) | ≤ 3 draw calls | 2–3 |

Geometry is cached per (kind, level, culture, seed bucket, construction step, damage step, owner
colour, lod) with ref-counting and an LRU of 96 unused entries; meshes share geometry and the
shared materials, so identical buildings can be batched/instanced by the renderer.

## 12. Do / Don't

* **Do** keep doors on +z, read culture from the roof, keep yards inside footprints, add one charming
  detail per building (sign, ale-stake, dovecote glover, block-cut ridge, rope weights…).
* **Do** reuse the parts kit (`house`, `buildRoof`, `opening`, `frameFace`, `chimney`, towers) so new
  content inherits construction/damage/snow/LOD behaviour automatically.
* **Don't** add textures, smooth-shaded hard surfaces, per-building materials, or thin single-sided
  geometry on the opaque channel (use the cloth channel). Don't exceed the budgets above.
* **Don't** light windows by day; don't make shadows pure black — the hemisphere fill must stay on.

## 13. Gallery

`?mode=gallery` — tabs for buildings / vegetation / crops / props / fx / contact sheets; culture,
level, construction, damage, seed, owner colour; season, progress, time of day, wind, snow,
shadows, wireframe; live triangle and draw-call stats. URL parameters reproduce any view, e.g.
`?mode=gallery&cat=sheets&sheet=levels&item=cottage`, `…&sheet=vegetation-seasons`,
`…&cat=buildings&item=cathedral&level=2&time=0.9`. `&shot=1` hides the UI.
Civilization pass sheets: `…&cat=sheets&sheet=stages-work` (every kind of a group at each stage, with site
piles), `…&sheet=stages&kinds=windmill,watermill&k=0.45` (named kinds, closer), `…&sheet=forts` (gates and
breaches), `…&sheet=siege` (siege works), `…&sheet=cultures&item=salt_pan`.

## 14. Civilization pass (wave B)

What the renderer and the asset kit draw for docs/CIV.md, and how to see each in the world viewer
(`?mode=world&preset=<name>`, shot by `node tools/render-shots.mjs civ` into `docs/render/civ/`) and the gallery
(`node tools/render-shots.mjs --civ-art` → `docs/art/civ/`).

**The five new works** (`src/assets/buildings/recipes/civ.ts`, all six cultures; doors in building-local metres,
+z the front, the first one the main door — the agents' `DOOR_X`):

| Kind | Look | Doors (x, z) | Triangles |
|---|---|---|---|
| `slaughterhouse` (L1 timber, L2 stone) | killing house with a wide door, a hanging rail under a pent roof with carcasses, block and cleaver, ox skull over the door, chimney, a fenced lairage pen | main (−0.20, 2.37–2.55), back (≈ −2.0, −3.0) | 877–1 317 |
| `clay_pit` | stepped pit face showing the strata, spoil banks, puddles, weathering heaps, clots drying under a pent shelter, spades, barrow, trough | (0, 5.95) | 1 113–1 171 |
| `salt_pan` | 3 × 2 shallow pans (brine, crust creeping in, raked rows), feeder channel and sluice, an open-fronted boiling house with the lead pan over a glowing furnace, steam out of a ridge louvre and under the eaves, salt heaps and draining baskets | (≈ 4.78, 5.82–6.00) at the cote's open front | 1 434–1 626 |
| `lumber_camp` | log hut, log piles, saw trestle, chopping block, a log drag, stumps and chips, a fire with a tripod pot | yard (0, 4.10), hut (−2.30, −0.25) | 2 158–2 182 |
| `gaol` | square stone lock-up (Norse: timber), pyramid roof with a ball finial, studded door with straps and lock, date stone, barred slits, ring and chain, bench | (0, 2.45) | 1 118–1 224 |

**Construction you can watch** (`src/assets/buildings/states.ts`, gallery `sheet=stages-*`; viewer `civ-site`): see
§8. Small sites (a well, the stocks) are staked at the corners only. Material piles beside a site come from
`src/sim/economy/propfeed.ts` (what has come in less what the work has used: timber, planks, stone, brick, straw,
clay), the new works' results from their keepers' stores (carcasses on the rail, joints, hides, tallow at the
slaughterhouse; brick hacks at kilns; clay heaps at pits; salt heaps at pans; log piles at lumber camps), and a carcass
hanging in a yard whose larder holds one.

**Quest marks** (`src/render/feedback/marks.ts`; `civ-marks`, `civ-marks-night`): a gold "!" (`mark: 'quest'`)
or a silver "?" (`'turnin'`) floating and bobbing over the head; full strength within 85 m, fading out by 100 m, never
under 22 px tall; behind a house or in a crowd drawn at reduced strength (a second pass without depth test, ray-tested
against buildings a few times a second per person); never for the player or anyone indoors. Nameplates keep a badge only
for `'track'`.

**Builder visuals** (`civ-builder`, `civ-ghost`, `civ-ghost-bad`, `civ-buildarea`): `setGhost` draws the asset
library's own model of the kind and level as a fresnel-lit translucent shell (mint when it fits, red when it does
not) with its footprint outlined and filled (hatched when red); only a kind/level/culture change asks for a model.
`setBuildArea` rasterises the union of the polygons into a mask (only when they change) that terrain, fields and
roads read: the land you may build on a touch brighter with a crisp edge line, the rest a touch darker; eased in and
out. `setOverview` turns the camera into an overhead rig at ~55° (orbit/zoom/pan routed to it, look-at kept inside
the circle, zoom 20 m – 2.2 R, ~0.8 s glide in and out, the previous mode restored); `getCameraMode()` reports
`'free'` while it is on.

**Orders on the ground** (`src/render/feedback/orderMarks.ts`; `civ-orders`): a move is a broad draped arrow with
chevrons running toward the goal, a retreat the same dashed, an attack or volley a ticked ring round the target with a
dashed line to it, a hold a ring of dashes and a flag on a pole; own gold, the selected group's bright and pulsing, the
enemy's red; wider with distance for the tactical view, faintly visible through the men standing on them; rebuilt only
when the list changes.

**Deposits** (`src/render/deposits.ts`, pieces in `src/assets/deposits.ts`; `civ-deposit-*`, `civ-map-deposits`):
iron as rust-stained outcrops on a reddened slope, stone as pale outcrops with a worked face and squared blocks, clay
as ochre banks with puddles by the water, salt as a white crust of plates, silver as blue-grey rock with pale veins,
gold as gravel and gold-flecked quartz along the stream with glints that catch the sun. Built only within 750 m
(full detail within 280 m), dropped beyond 900 m, kept clear of roads, fields, water and buildings and rebuilt when a
building comes by. On the map: an icon by kind (`src/render/map/mapLabels.ts`), and outposts get their own marker.

**Siege and war** (`src/render/siege.ts`, models in `src/assets/siege.ts`; `civ-siege`, `civ-siege-broken`, gallery
`sheet=siege`, `sheet=forts`): gates and breaches from `view.forts()` (rebuilt when `fortsVersion()` moves); siege
works from `view.siegeWorks()` — scaling ladders by length against the walls, a roofed ram whose log swings with
`swing` (0 drawn back … 1 struck), mantlets, trebuchet and mangonel whose arms follow their throwing phase; a burning
work is charred and throws fire and smoke, a broken one lies tipped over.

**Bodies and props**: clips `bound`, `bound_walk` (wrists tied before the belly), `climb` (hand over hand),
`push` (shoulder to a ram's beam; walkable); the cleaver; a halter rope from the leader's nearer hand to a led
animal's head (`AnimalDrawItem.ledBy`; it sags when slack, never thinner than ~1 px) and turns of rope round a
captive's wrists (`civ-led`, `civ-works`); props for the new work (`src/assets/props/civProps.ts`).

**Measured** (tests/render/civ.perf.test.ts, `npm run test:perf`; the world-viewer presets at medium quality, this branch
against its base 372c7ca run side by side, two rounds each, on a shared 4-core machine at a load of 30–50 — SwiftShader
makes every frame seconds long there, so only the comparison means anything):

| Preset | Frame, base → this branch (ms, GPU-synced, 320×180) | Render CPU (ms) | Draw calls | Triangles |
|---|---|---|---|---|
| village | 2 972 / 3 199 → 3 310 / 3 005 | 13.0 / 16.3 → 14.1 / 15.4 | 263 → 263 | 1.51 M → 1.51 M |
| town | 3 144 / 3 769 → 3 275 / 3 175 | 15.7 / 18.2 → 18.0 / 20.6 | 364 → 364 | 1.50 M → 1.50 M |
| castle | 4 239 / 3 575 → 3 999 / 3 511 | 19.1 / 17.4 → 19.7 / 17.2 | 394 → 399 | 1.494 M → 1.503 M (a deposit in view) |

Unchanged within the noise (which runs ±10 % between two rounds of the same build). The new layers cost ~0.06 ms a frame
together when idle or showing a village's marks, orders, deposits and ten siege works (marks ≈ 0.01, orders ≈ 0.01,
tint < 0.001, deposits ≈ 0.03, siege ≈ 0.02 ms) and ~0.3 ms while a ghost is dragged (it re-drapes its outline).
Draw calls only while something is shown: the marks 2 in all, a deposit in view ≤ 3, a siege work 1–2, the ghost 2 per
mesh of its model plus 2, the orders 3.
