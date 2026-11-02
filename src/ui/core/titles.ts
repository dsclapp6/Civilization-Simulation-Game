// How a person is addressed: "Sir Godwin Smith" for a knight (civilization pass, CIV §9). Pure.
import { fullName, type Person } from '../../sim/state';

type Namely = Pick<Person, 'first' | 'byname' | 'sex' | 'career'>;

/** "Sir" for a knight (only men are knighted), else nothing. */
export function honorific(p: Pick<Person, 'sex' | 'career'>): string {
  return p.sex === 'm' && p.career === 'knight' ? 'Sir' : '';
}

/** The full name with the honorific: "Sir Godwin Smith". */
export function styledName(p: Namely): string {
  const h = honorific(p);
  return h ? `${h} ${fullName(p)}` : fullName(p);
}

/** The first name with the honorific: "Sir Godwin". */
export function styledFirst(p: Namely): string {
  const h = honorific(p);
  return h ? `${h} ${p.first}` : p.first;
}
