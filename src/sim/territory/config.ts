// Every tunable number of the territory module (docs/world/RESOURCES.md, "Territory").
export const TERRITORY = {
  /** Land within this distance (m) of an outpost belongs to the outpost's House (CIV §4). */
  outpostClaim: 600,
  /** An enclosed deer park round a castle: woodland within this distance (m) of its walls is the lord's park. */
  parkRadius: 450,
  /** Woodland map value (0..1) from which open ground within someone's lands counts as forest. */
  forestMin: 0.3,
  /** A road's surface plus this margin (m) is road. */
  roadMargin: 1.0,
  /** Spacing (m) of the lattice a settlement's resource profile is sampled on. */
  profileStep: 160,
  /** Most samples of one profile (large lands are sampled more coarsely). */
  profileMaxSamples: 700,
  /** Share of a profile's woodland above which it yields timber, and above which firewood. */
  timberForest: 0.18,
  firewoodForest: 0.06,
  /** Least mean fertility for a place to count as grain country. */
  grainFertility: 0.25,
  /** Distance (m) over which a hostile army near a castle puts it on alert. */
  alarmRadius: 1500,
  /** Opinion at or below which a lord counts a person his enemy (social tuning: enemyAtOrBelow). */
  enemyOpinion: -50,
  /** Age (years) under which a title's holder is a child and the regent acts. */
  adultAge: 16,
  /** Outline of a settlement's lands (`landsPolygon`): rays of the first pass, march (m) along a ray, tolerance (m) of the chords. */
  outlineRays: 64,
  outlineMarch: 20,
  outlineTolerance: 8,
  /** Outline of an outpost's claim (`outpostPolygons`), the same three for a disc of 600 m. */
  claimRays: 32,
  claimMarch: 20,
  claimTolerance: 4,
} as const;
