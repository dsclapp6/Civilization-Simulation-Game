// How the law names people (pure): "Sir Hugh", "Lord Mortimer", "Lady Maud", "Abbot Hamo", "Wat Harper".
import { fullName, type Person } from '../state';

export function titled(p: Pick<Person, 'first' | 'byname' | 'sex' | 'rankTier' | 'career'> | undefined | null): string {
  if (!p) return 'the lord';
  const by = p.byname || p.first;
  if (p.career === 'abbot') return p.sex === 'f' ? `Abbess ${p.first}` : `Abbot ${p.first}`;
  if (p.career === 'prior') return p.sex === 'f' ? `Prioress ${p.first}` : `Prior ${p.first}`;
  if (p.career === 'bishop') return `Bishop ${p.first}`;
  if (p.rankTier >= 6) return p.sex === 'f' ? `Lady ${by}` : `Lord ${by}`;
  if (p.rankTier === 5) return p.sex === 'f' ? `Lady ${p.first}` : `Sir ${p.first}`;
  return fullName(p);
}
