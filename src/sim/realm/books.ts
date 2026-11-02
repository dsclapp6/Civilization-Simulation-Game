// The treasury's books: what came into the ruling household's purse and what went out over a rolling year (docs/CIV.md §6.1).
// The realm enters its own dealings (sales, wages, research, troops' gear, purchases) by label; everything else that moved the
// purse since the last close (rents and dues, the household's own spending, works paid by the construction module) is seen as
// the difference and counted as other income or other spending. Closed once a day; saved in `state.ext['realm'].books`.
import { LEDGER_DAYS, RULING_TITLES } from './config';
import type { BookRec, Rlm } from './store';
import type { AccountLine } from './types';

function fresh(purseNow: number): BookRec {
  return { last: purseNow, day: -1, inn: 0, out: 0, cats: {}, b: [] };
}

function bookFor(R: Rlm, hhId: number, shift: number): BookRec | null {
  const hh = R.state.households.get(hhId);
  if (!hh) return null;
  const key = String(hhId);
  let b = R.data.books[key];
  // a book opened by an entry starts from the purse as it was before the entry (the caller has changed the purse already)
  if (!b) { b = fresh(round(hh.purse + shift)); R.data.books[key] = b; }
  return b;
}

const round = (v: number): number => Math.round(v * 100) / 100;

/** An income the realm itself earned (call after the purse has been credited). */
export function bookIn(R: Rlm, hhId: number, pence: number, label: string): void {
  if (pence <= 0) return;
  const b = bookFor(R, hhId, -pence);
  if (!b) return;
  b.inn = round(b.inn + pence);
  b.cats[label] = round((b.cats[label] ?? 0) + pence);
  R.touch();
}

/** A spending the realm itself made (call after the purse has been debited). */
export function bookOut(R: Rlm, hhId: number, pence: number, label: string): void {
  if (pence <= 0) return;
  const b = bookFor(R, hhId, pence);
  if (!b) return;
  b.out = round(b.out + pence);
  b.cats[label] = round((b.cats[label] ?? 0) - pence);
  R.touch();
}

/** The treasury households of everyone who rules: the purses worth keeping books for (ids, sorted). */
export function treasuries(R: Rlm): number[] {
  const set = new Set<number>();
  for (const t of R.state.titles.values()) {
    if (!RULING_TITLES.has(t.kind) || !t.holder) continue;
    const h = R.state.persons.get(t.holder);
    if (h && !h.death && h.household) set.add(h.household);
  }
  return [...set].sort((a, b) => a - b);
}

/** Closes the day's books of every treasury (once a day, late). */
export function closeBooks(R: Rlm): void {
  const day = Math.floor(R.day);
  const slot = ((day % LEDGER_DAYS) + LEDGER_DAYS) % LEDGER_DAYS;
  const live = new Set<string>();
  for (const id of treasuries(R)) {
    const hh = R.state.households.get(id);
    if (!hh) continue;
    const key = String(id);
    live.add(key);
    let b = R.data.books[key];
    if (!b) { R.data.books[key] = { last: hh.purse, day, inn: 0, out: 0, cats: {}, b: [] }; continue; }
    if (b.day === day) continue;
    // what moved the purse that the realm did not enter itself
    const ext = round(hh.purse - b.last - b.inn + b.out);
    const income = round(b.inn + Math.max(0, ext));
    const spending = round(b.out + Math.max(0, -ext));
    while (b.b.length < LEDGER_DAYS) b.b.push([0, 0]);
    // days nobody closed (the clock skipped, or the book is new) count for nothing
    const gap = day - b.day;
    for (let i = 1; i < Math.min(gap, LEDGER_DAYS + 1); i++) b.b[(((b.day + i) % LEDGER_DAYS) + LEDGER_DAYS) % LEDGER_DAYS] = [0, 0];
    const cats = Object.keys(b.cats).length > 0 ? b.cats : undefined;
    b.b[slot] = cats ? [income, spending, cats] : [income, spending];
    b.last = hh.purse;
    b.day = day;
    b.inn = 0; b.out = 0; b.cats = {};
  }
  // books of households that no longer rule go after a while
  for (const key of Object.keys(R.data.books)) {
    if (live.has(key)) continue;
    const b = R.data.books[key];
    if (day - b.day > LEDGER_DAYS * 2) delete R.data.books[key];
  }
  R.touch();
}

/** A rolling year: pence in and out (closed days plus today's entries so far). */
export function yearOf(R: Rlm, hhId: number): { income: number; spending: number; lines: AccountLine[] } {
  const b = R.data.books[String(hhId)];
  if (!b) return { income: 0, spending: 0, lines: [] };
  let income = b.inn, spending = b.out;
  const cats: Record<string, number> = { ...b.cats };
  for (const e of b.b) {
    income += e[0]; spending += e[1];
    if (e[2]) for (const k of Object.keys(e[2])) cats[k] = (cats[k] ?? 0) + (e[2] as Record<string, number>)[k];
  }
  let ownIn = 0, ownOut = 0;
  const lines: AccountLine[] = [];
  for (const k of Object.keys(cats).sort()) {
    const v = round(cats[k]);
    if (v > 0) ownIn += v; else ownOut += -v;
    lines.push({ label: k, pence: v });
  }
  const restIn = round(income - ownIn), restOut = round(spending - ownOut);
  if (restIn > 0.005) lines.push({ label: 'Rents, dues and other receipts', pence: restIn });
  if (restOut > 0.005) lines.push({ label: 'Household, works and other costs', pence: -restOut });
  lines.sort((a, b) => Math.abs(b.pence) - Math.abs(a.pence) || (a.label < b.label ? -1 : 1));
  return { income: round(income), spending: round(spending), lines };
}
