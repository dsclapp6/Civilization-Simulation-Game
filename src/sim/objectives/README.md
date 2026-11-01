# Objectives (`src/sim/objectives`)

Clarity-pass module (design: `docs/CLARITY.md` §2, §3). It owns **what the player should be doing**: concrete,
located and checkable steps, one of them tracked, shown on the HUD tracker, as a beacon in the world, on the compass
and minimap. `installObjectives(sim, deps): ObjectivesRuntime` (an `ObjectivesApi`, `types.ts`) is installed last in
`app/session.ts` and handed to the UI as `GameServices.objectives`. Headless: the zone and the player module are
optional (`deps.zone` guards, `sim.view.player()` falls back to the home door).

```
npx vitest run tests/sim/objectives         # the module's tests (about 80)
```

## Sources

| source | made by | when | steps (all located) |
|---|---|---|---|
| `tutorial` | `tutorial.ts` | the first day of a run: a chain per birth chain (`farm` serf/free, `craft`, `merchant`, `noble` gentry/knightly, `baron`), each stage made when the one before is done, from what is really at hand; lapses after 3 days | meet the family member at hand (the head if near) · work on a strip / at the bench / in the garden / the animals (the registry says what is doable) or look for work · a neighbour's errand · buy or sell at a shop or the market · pray and lessons (a page), the steward and two villagers (an heir) · home and sleep (made in the evening). A stage that cannot be made today is skipped; one nobody gets to in a day and a half lapses |
| `chore` | `chores.ts` | each dawn (the first dawn hour of the day, once): the head sets 1–3 (2 for a child under 14, 1 with a job), from the household plan, the season, the strips' next tasks (`economy.holding`), animals and garden (asked of the action registry at the household's buildings), the woodpile, errands, lessons; on the holy day Mass and the butts | one step each; pays 1d or ½d from the head's purse (never more than half of it) and +1 opinion; ignored altogether it costs 1 opinion; lapses at the next sunrise |
| `job` | `work.ts` | dawn, workdays: the duty of a post (`economy.employment`): bench for apprentices and journeymen, the demesne for day labour, the flock for herd/shepherd, the butts for archers, else report to the employer; a serf's week-work (`obligations`) | go there, then N bouts counted at the place |
| `goal` | `goals.ts` | always a few (≤ 3): choose a path (at 14: age countdown, then `manage.career`), join the archers (`entryTests`: STR, Archery, a bow, the oath), win an apprenticeship (`jobs`: premium, master, indenture), save for a good tool (price from `economy.price`), find someone to love (`matchCandidates`, `courtship`) | state-based: a stat, a skill, a purse, a courtship, a career change |
| `request` | `requests.ts` | every `request` of the happenings; mirrors the record (hear → accept → the type's work → hand over) and rebuilds its steps from it | |
| `story` | `story.ts` | a dear one gravely ill (visit, pray), the wedding feast (church, the morning after, a window), a child born (home), the lord's levy call (`military.service().call`) | |

Auto-tracking (`core.retrack`): the player's pick (`track(id)`) while it lives, else story > tutorial > job >
chore > request > career > goal, then earliest due. `suggestions()` (`suggest.ts`): the tracked step, then hunger /
exhaustion (starving or spent outranks the tracked step), the dark (home), the market day (what to sell), the holy
day (Mass, the butts), a villager waiting for a word, a perk to choose, and honest ideas when nothing presses.

## Steps and how they finish (`match.ts`)

A step carries a `Match` (plain data, saved): `talk`, `talkAny`, `act` (N completed actions whose option id matches
`farm.*` or an exact id, optionally on one target), `strip` (a strip's task: state-based, also true if the household
did it), `reach` (within r metres, or on a strip; optional day window), `trade`, `have` (pack/stores), `sleep`,
`skill`, `stat`, `money`, `career`, `req`/`reqwork` (happenings records), `wait`, `age`, `court`, `flag`.
Only the **current** step of each live objective is ever looked at: on the events `action`, `conversation`, `trade`,
`skip` (sleep start), `skillLevel`, `careerChanged`, `marriage`; on the hourly hook; and in a perStep poll once a
second (every fifth poll also the heavier kinds). Nothing scans the population per frame.

## Day summary (`summary.ts`)

The log of the day (work by kind and place, finished tasks apart from bouts, goods, money in/out reconciled against
the purse, skill/stat snapshots) becomes a `DaySummary` when the player lies down (`skip` sleep start) or midnight
passes, and `dayEnd { day }` is emitted (only for a day with something in it, once per day). The last 8 are kept.

## World, zone and the UI

* `sim.view.setSource('worldMarkers')`: the tracked step's target (primary, `kind: 'objective'`, people live via
  `zone.agent` else `zone.whereabouts`), home, work (the employment's building), a person asked for with
  `trackPerson`, a place with `trackPlace`. Ids 9001–9005; the array is reused between frames.
* Quest marks (Builder 1's hook, guarded): `zone.setQuestGivers?.(ids, trackedPerson?)` is called whenever the set of
  people with business for the player changes (request askers, the person a talk step needs, active `giver`s of a
  talk step) — `ids` sorted, `trackedPerson` the person marked with "Find" (0/undefined: none).
* Additive API (`types.ts`, all optional): `trackPlace`, `found`, `places` (home, strips, church, market, smithy,
  alehouse, mill, butts, well, workplace…), `version` (changes whenever the list changes: cheap HUD refresh).
* Events: `objective { phase: added|progress|done|failed|expired, id, title }`, `dayEnd { day }`. Notices
  (`notify`): the head's call at dawn (`quest`), the head's reaction when a chore is done (`social`), a fine (`loss`).

## Saved state and determinism

`state.ext['objectives']` (`core.ObjSave`): objectives with their step matchers, the tracked id, the tutorial stage,
cooldown marks, the day's log and the last 8 summaries — about 5–15 KB. No `Math.random`; no hidden state (caches are
pure functions of the section and the world). Save → load → continue gives the same `stateHash()`
(`tests/sim/objectives/save.test.ts`). A change of character (`playerSwitched`) clears the objectives and starts
goals and chores afresh (no tutorial).

## Wording (`src/content/objectives/*.json`)

Flat dictionaries `key: "text with {placeholders}"`; a `chain:` prefix gives a variant for one tutorial chain.
`tutorial.json` also lists the stages of each chain. `data.ts` loads them (`T(dict, key, vars, chain)`); tests turn
strict mode on so a missing key fails. `tests/sim/objectives/content.test.ts` checks every text and placeholder.

## Costs

Events and the hourly hook: well under 0.1 ms each (see `tests/sim/objectives/objectives.perf.test.ts`); dawn work
(chores, jobs, goals) about 1–3 ms once a day; a poll about 20 µs. The registry is asked about a dozen targets when
an objective is made, never per frame.
