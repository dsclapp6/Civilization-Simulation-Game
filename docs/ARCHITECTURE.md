# Millennia — Architecture & Build Rules

Read `docs/SPEC.md` first (what the game is). This file is how it is built. It is the
binding brief for every contributor and subagent.

## 1. Stack and commands
- TypeScript (strict) + Vite 8 + Three.js 0.186 (`WebGLRenderer`, WebGL2). **No other runtime
  dependencies.** Dev-only: vitest, tsx, @types/*. Do not add packages.
- `npm run dev` (Vite dev server) · `npm run typecheck` · `npm test` (vitest) · `npm run test:perf` (timing budgets, run alone) ·
  `npm run build` · `npx tsx tools/<tool>.ts` for Node tools.
- Playwright + Chromium are preinstalled on the build machine: `require('playwright')` works,
  `chromium.launch()` needs no options, WebGL2 runs on SwiftShader (slow but correct).
  Use it for screenshot checks (`tools/*-shots.mjs`). Never run `playwright install`.
- Git worktrees have no `node_modules`; run
  `ln -s /home/user/Civilization-Simulation-Game/node_modules node_modules` in the worktree root.

## 2. Modes (URL `?mode=`)
| mode | entry | purpose |
|---|---|---|
| `game` (default) | `src/app/game.ts` | the game |
| `world` | `src/render/worldViewer.ts` | fly over a generated continent (renderer dev) |
| `gallery` | `src/gallery/main.ts` | browse buildings, vegetation, crops, props, fx |
| `chars` | `src/gallery/characters-main.ts` | characters, horses, animals, animations |
| `village` | `src/agents/dev/villageViewer.ts` | a settlement living its day: agents, routines, animals (wave 2 dev) |
| `ui` | `src/ui/dev/gallery.ts` | every UI screen and panel with mock data (wave 2 dev) |

Common params: `seed`, `quality=low|medium|high`, `time` (0..1 day fraction), `season` (0..3).

## 3. Directory layout
```
src/core/      shared utilities + CONTRACTS (math, rng, noise, heap, time, events, domain, view)
src/content/   shared data tables (JSON) + typed loaders
src/world/     continent generation (static per seed) — world/types.ts is a CONTRACT
src/sim/       simulation: state, clock, population, life, economy, politics… (no DOM, no three)
src/agents/    detailed agents near the player: navigation, routines, steering (wave 2)
src/player/    possession, controls, interaction, switching (wave 2)
src/assets/    procedural models, materials, animated layers — assets/types.ts is a CONTRACT
src/render/    renderer: terrain streaming, water, sky, lighting, vegetation, cameras, post FX
src/ui/        DOM UI (HUD, panels, dialogs) (wave 2)
src/app/       game bootstrap and main loop
src/gallery/   asset galleries
tools/         Node/Playwright tools (headless sim, map dumps, screenshots)
tests/         vitest suites, mirroring src/
docs/          SPEC, ARCHITECTURE, ART, screenshots
```

## 4. Contracts (do not break)
- `src/core/*.ts`, `src/content/types.ts`, `src/content/buildings.json`,
  `src/world/types.ts`, `src/assets/types.ts`, `src/core/view.ts`.
- Owners of a module may **add optional fields/members**; never rename/remove. Any contract
  change must be listed in your final report. `src/assets/palette.ts` values may be tuned by
  the asset owner (keys are contract).
- Dependency rules (enforced by review):
  - `core` → nothing. `content` → core. `world` → core, content.
  - `sim` (incl. `sim/economy`, `sim/social`) → core, content, world (types + generator), `assets/palette.ts` (data only).
  - `agents` → the same + sim. `player` → the same + sim + `agents` (types / ZoneApi).
    `combat` (wave 3) → like `player`, and may also use `player/types`.
  - None of `sim`, `agents`, `player` may use **three or the DOM** (except `sim/save-idb.ts`, IndexedDB).
  - `assets` → three, core, content, world/types.
  - `render` → three, core, content, world/types, assets (types + library).
  - `ui` → core, content, world/types, sim (read API `sim/api.ts`, types, commands), `agents/types`,
    `player/types`, DOM. No three.
  - `app` → everything.

## 4b. Gameplay modules (wave 2) and how they plug together
Wave 2 contracts: `sim/actions.ts` (player verbs), `sim/calendar.ts`, `sim/skills.ts`, `sim/money.ts`,
`sim/api.ts` (UI read helpers), `sim/economy/types.ts`, `sim/social/types.ts`, `agents/types.ts`,
`player/types.ts`, `ui/types.ts`. Each module exposes one entry point in its `index.ts`;
`app/game.ts` installs them in this order on a `Simulation`:
```
social  = installSocial(sim)                          // src/sim/social
economy = installEconomy(sim, { social })             // src/sim/economy (registers actions + topics)
zone    = installAgents(sim, { economy, social })     // src/agents (view sources: characters, animals)
player  = installPlayer(sim, { zone, economy, social })  // src/player (view sources: player, focus, mode, markers)
ui      = createUI(root.ui, host)                     // src/ui (reads GameServices from the host)
```
- **Actions** are how anything gets done: providers register on `sim.actions`; the player controller
  lists options for the target in front of the player and starts one; timed actions run in simulated
  seconds while the body plays the action's animation; outcomes reach the HUD via `notify`/`ui` events.
- **Commands** (`sim.dispatch`) cover global controls (speed, pause, sleep, switch character).
- **View sources** (`sim.view.setSource`) let modules feed the renderer without touching `view-impl.ts`.
- **Events** (`sim.events`, `sim/events.ts`) carry ids only; the UI listens for `notify`, `ui`,
  `action`, `skillLevel`, `playerDied`, `gameOver`…
- **State**: modules keep their own saved data in `state.ext['<module>']` (call `state.touchExt`), or
  in existing entity fields (`Person.inventory`, `Household.stores`, `BuildingState`, `StripState`).

## 5. Units and conventions
- 1 unit = 1 metre. Three.js axes: **x east, z south, y up**. Map points `{x, z}` (`core/math.P2`).
- Continent spans `0..WORLD_SIZE` (16 000 m) on x and z. Sea level y = 0.
- Yaw: 0 faces +z, π/2 faces +x (`yawTo`). A building's door is on its local +z side.
- Humans ≈ 1.55–1.85 m adults; horses ≈ 1.5 m at the withers; cottage ridge ≈ 5 m;
  church tower ≈ 15–20 m; keep ≈ 18–25 m.
- Colours are `0xRRGGBB` numbers; renderer output is sRGB with ACES filmic tone mapping.
- Nominal lighting the assets are authored for: sun `DirectionalLight` intensity ≈ 3.0 at
  noon, `HemisphereLight` ≈ 0.9 (sky `0xbfd9ef`, ground `0x6b5a3a`), exposure 1.0. Night:
  moon ≈ 0.35, lit windows/torches emissive.

## 6. Determinism
- All randomness through `core/rng.Rng` seeded from the run seed (`rng.fork(label)` per
  subsystem). Visual-only variation may use `core/math.hash3/hash01` keyed by stable ids.
- World generation is a pure function of `(seed, options)`; the sim never stores the world,
  it regenerates it from the seed on load and applies its own dynamic state on top.

## 7. Main loop and time
- `app` drives `requestAnimationFrame`. Per frame: `sim.step(realDt)` then
  `renderer.render(sim.view, realDt)`.
- Inside `sim.step`: fixed sub-steps of `SIM_DT` (1/20 s) × speed for detailed agents;
  the calendar advances by `realDt × speed × calendarRate / DAY_SECONDS` days. Hourly, daily,
  seasonal and yearly hooks fire from the calendar (macro systems run on them).
- Speeds 1×/3×/8×, pause, action time (`ACTION_TIME_FACTOR`), sleep/wait skips (advance the
  calendar quickly with detailed agents frozen or teleported to schedule positions).
- The renderer interpolates nothing itself: the sim exposes current positions each frame
  (agents move every sub-step; at 60 fps with 20 Hz steps the agent layer may interpolate
  internally using previous-step positions).

## 8. Data flow
```
generateWorld(seed) ──► WorldModel (static, read-only)
                              │
Simulation (GameState) ◄──────┘   commands ◄── player controller / UI
   │  macro systems (calendar hooks): life, economy, politics, AI, events
   │  detail systems (sub-steps): agents, combat, projectiles near the player
   ▼
SimView (core/view.ts) ──► GameRenderer (render) ──► asset layers (assets)
   └──► UI reads a richer read-only Sim API (wave 2)
```

## 9. Level of detail
- **Macro tier (everyone, ~10–15k people):** records updated on calendar hooks (daily life,
  aging, births, deaths, work output, opinions). No positions beyond "at home / at work /
  travelling".
- **Detail zone:** people within ~250 m of the player become agents with positions, paths,
  animations and full behaviour (target ≤ 300 agents + ≤ 150 animals). On leaving the zone
  they fold back into the macro tier at the place their schedule says.
- **Map view:** terrain at low detail, settlements as models/icons with labels, armies,
  caravans and your party as markers. Travel happens here.

## 10. Rendering overview (owner: render)
- Terrain: chunked quadtree/clipmap LOD streamed around the camera from `world.heightAt` and
  `world.groundAt`, vertex-coloured, flat-shaded, with skirts; generation time-sliced
  (≤ 4 ms/frame). Map view uses a coarse whole-continent mesh.
- Water: sea plane with shoreline foam, lake surfaces, river ribbons following
  `River.points/widths/surface` with flow animation.
- Sky: gradient dome, sun/moon, stars, clouds; fog for aerial perspective; seasons tint
  foliage; snow cover in winter; rain/snow particles.
- Instancing for vegetation (`world.scatterInChunk`, minus `view.felled()`), crops on strips,
  repeated buildings; asset layers for characters/animals/projectiles/fx.
- Cameras: third-person follow (orbit with mouse, terrain/building collision), street-level
  free camera (dev), smooth zoom-out to the map view.
- Quality presets low/medium/high (shadows, draw distance, post FX, pixel ratio).

## 11. Persistence (owner: sim)
- IndexedDB database `millennia`: store `profile` (Legacy gold per level, records, settings)
  and store `run` (the single current run). No other save slots.
- Save = versioned JSON of dynamic state (world regenerated from seed). Migrations keyed by
  version. Incremental/dirty-chunk saving so a save never blocks a frame > 16 ms.
- Autosave every ~10 s of real time and immediately on important events (death, birth of
  the player's heir, rank change, battle end). Game over deletes the run and updates records.

## 12. Testing and tools
- vitest suites in `tests/<module>/`. Pure modules must be testable in Node.
- `tools/headless.ts` (sim): runs a continent for N years, prints demographics/economy checks.
- `tools/worldmap.ts` (world): PNG overview of a generated continent.
- `tools/*-shots.mjs`: Playwright screenshots for visual review (galleries, renderer).
- Every contributor runs `npm run typecheck` and `npm test` before finishing.

## 13. Performance budgets (mid-range desktop, 1080p, medium quality)
- 60 fps target, never below 30 in normal play.
- Draw calls < 600; triangles < 2.5 M; JS frame time < 8 ms (sim < 3 ms at 1×, < 6 ms at 8×).
- Characters: 300 animated people + 150 animals in ≤ 40 draw calls, CPU update < 3 ms.
- World generation < 4 s in a browser; `heightAt` < 2 µs average.
- Save < 16 ms per frame slice; memory < 1.5 GB.

## 14. Art direction (summary — `docs/ART.md` is authoritative once written)
- **Stylized low-poly, flat-shaded, solid colours** (vertex colours, procedural materials; no
  external textures or models). Chunky readable silhouettes, warm natural palette
  (`src/assets/palette.ts`), soft shadows, atmospheric fog, golden hours, moonlit blue nights,
  warm lit windows and torches.
- **Real medieval vernacular** (England and neighbours): cruck-framed cottages, cream
  wattle-and-daub between dark timbers, thick golden thatch; stone parish churches with
  towers; jettied timber-frame townhouses; manor halls; motte-and-bailey castles, square stone
  keeps, curtain walls, gatehouses; watermills with turning wheels, post windmills with
  turning sails; forges glowing. Cultures vary roofs/materials (e.g. norse turf roofs and
  longhouses, teuton half-timbering with tile, franc steeper slate/tile, gael/cymric stone and thatch).
- **Upgrades are visible** (levels add size, chimneys, outbuildings, better roofs).
  Construction shows scaffolding; damage shows holes, scorch, collapse.
- **People read by rank at a glance:** undyed russet and rags for serfs, dyed wool for
  middling folk, rich colours and trim for gentry, heraldic surcoats for knights, robes and
  habits for clergy; hoods, coifs, straw hats, veils and wimples; visible armour (padded,
  mail, plate). Children small, elders greyer and slightly stooped.
- **Animation is the soul:** natural walk/run cycles with arm swing and bob, idle breathing,
  tool-specific work loops, real combat swings, bow draws, riding posture with proper horse gaits.
- **Animals** have unmistakable silhouettes (woolly sheep, horned oxen with yokes, tusked boar,
  antlered stags, lean wolves…).
- **UI:** parchment and ink, illuminated-manuscript accents (gold, vermilion), serif type.

## 15. Coding conventions
- Small focused modules; pure functions where possible; no globals except constants.
- Data-driven content in `src/content/*.json` with typed loaders.
- Comments explain *why*; keep them sparse. Names are explicit (`seasonProgress`, not `sp`).
- No `any` (use `unknown` + narrowing). Avoid per-frame allocations in hot paths.
- Dispose Three.js geometries/materials you create.

## 16. Rules for subagents
1. Work only inside the paths you own (listed in your brief). Read anything.
2. Respect §4 contracts and dependency rules. Additive optional changes only; report them.
3. Commit your work to your branch with clear messages (`git add -A && git commit`). Do not push.
4. Before finishing: `npm run typecheck` and `npm test` pass; your tool/screenshot scripts run.
5. Visual work: take screenshots with Playwright, **look at them yourself**, and iterate until
   they meet `docs/ART.md` quality. Commit the final screenshots.
6. Final report: what you built, files, how to run and verify, measured performance,
   known gaps, contract changes.
