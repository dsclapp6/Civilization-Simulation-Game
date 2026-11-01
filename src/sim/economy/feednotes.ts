// What the player's work leaves lying about, remembered for a while only to be drawn (clarity pass): the stump and logs
// of a felled tree, the hay cut in a meadow, the stone broken out at a quarry. Not saved: a load forgets the fresh
// logs and the hay, while the stumps are known from the felled trees the run does save. Written by the work actions
// (work-craft.ts, work-farm.ts), read by propfeed.ts.

export interface FelledNote {
  /** Scatter id of the tree. */
  id: number;
  x: number;
  z: number;
  scale: number;
  /** Logs the tree gave. */
  logs: number;
  day: number;
}

export interface FeedNotes {
  /** Counts the notes written, so the prop feed notices a new one inside the hour it last looked. */
  rev: number;
  felled: FelledNote[];
  /** Meadow parcel → bales cut this year and the day of the last cutting. */
  mown: Map<number, { bales: number; day: number }>;
  /** Quarry or pit building → blocks broken out recently and the day of the last of them. */
  dug: Map<number, { blocks: number; day: number }>;
}

export function newFeedNotes(): FeedNotes {
  return { rev: 0, felled: [], mown: new Map(), dug: new Map() };
}
