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
| Window | Standard, dark glass `#1d1814`, roughness 0.5 | Emissive = vertex colour (warm `#ffb057` × per-window 0.18–1.0) × level × night. 5 shared lit levels (`setLit`). |
| Glow | `MeshBasicMaterial` ×1.9 with flicker | Forges, kilns, bloomeries, campfires. Always on (bloom-friendly). |
| Cloth | Standard, DoubleSide | Flags, awnings, tents, tenter cloth: travelling wave from `aSway`; matching depth material. |
| Water | Standard, roughness 0.12 | Mill races, wells, vats; slow shimmer. |
| Vegetation | `MeshLambertMaterial`, one per scatter kind (shared program) | Wind sway, seasonal tint (2 tints mixed per instance), leaf fall/bud burst (faces shrink into clump centres), blossom, fruit, petals, snow. Thin plants (`soft`) use smooth up-bent normals so they light like the ground. |

All materials take fog; none needs textures. Per-instance variation is a hash of the instance
position (no `instanceColor` needed; if the renderer sets one it multiplies in).

## 6. What the renderer must provide

* `WebGLRenderer`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`,
  exposure **1.0**. No `scene.environment` (or ≤ 0.3 intensity) — Lambert vegetation ignores it.
* **Day:** sun `DirectionalLight` 3.0 at noon (colour `palette.sun.day`), easing to 0.75× and
  `palette.sun.dusk` near the horizon; `HemisphereLight` 0.9 (sky `#bfd9ef`, ground `#6b5a3a`),
  warmed toward `#e8b896` at golden hour.
* **Night (moonlit blue):** moon `DirectionalLight` **0.9** `palette.sun.moon`; hemisphere
  0.27 + **0.75** (sky `palette.ambient.night #3a4c80`, ground `#1e2433`). The gallery's
  `computeLighting()` (`src/gallery/stage.ts`) is the reference implementation.
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
* **Construction** (`construction < 1`, 10 cached steps): marking-out pegs → foundations → timber
  frame rising ahead of the infill → walls (ragged course top) → rafters/battens → roof laid from the
  eaves up → doors/windows; scaffolding (poles, ledgers, platform, ladder) and a materials pile.
* **Damage** (4 cached steps): soot and char (timber chars black), roof holes revealing charred
  rafters, smashed dark windows, ragged partial collapse at ≥ 0.5, rubble and fallen beams, ruin at 1.
* **Animated parts:** watermill/fulling-mill wheels, post-mill buck turning into the wind with
  spinning sails, quarry treadwheel, swinging inn/smithy signs, quintain arm, flags/pennants.
* **Wall segments** (`palisade` 4 m, `wall` 6 m) run along local x, outside on +z, and tile
  seamlessly (stake/merlon/course periods divide the segment length).
* **Water side:** watermills, fulling mills and tanneries carry their own raised mill race / pits
  behind the building (local −z); docks put the river on local −z.
* **LOD:** `request.lod` 0 ≤ 120 m (all detail), 1 ≤ 400 m (no yard decor, coarse roofs, corner posts
  only), 2 beyond (silhouette, lit windows kept for night views).

## 9. Vegetation, crops, props

* Trees: trunk + limbs + 5–7 faceted canopy clumps (LOD0), 2 clumps (LOD1), octahedron + spike
  (LOD2). Conifers: tiered cones (spruce), clouded flat tops on a red trunk (Scots pine).
  Scale 1 = typical adult. One geometry + one material per kind/LOD, instancing-ready.
* Crops: 12 kinds × 4 stages, one clump ≈ 0.5 m, plant every ~0.5 m in rows; colours baked per stage
  (green → gold), drooping barley, oat panicles, blue flax, rosettes, bulbs; fallow = grass, docks,
  poppies.
* Props: 36 kinds, origin at base centre, front +z; fences (2–3 m) tile along x. Compact low-poly
  variants (`decorInto`) dress building yards inside the footprint.

## 10. FX and projectiles

* FX: one ring buffer each of alpha-blended (4096) and additive (2048) billboards → **2 draw calls**.
  Motion (drag, gravity/buoyancy, wind) is evaluated in the vertex shader from spawn data; shapes:
  soft puff, droplet, tumbling chip, velocity-aligned spark streak, flame teardrop. Smoke dims at night.
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
