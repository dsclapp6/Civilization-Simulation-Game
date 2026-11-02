// Fields & labour: what each field of each manor is sown with next, the share of the week-work sent to the works, and the manor's
// dues and labour policy (the existing politics API; the full page is its Command tab). Your own household's chores are the family
// panel's (CIV §6.3).
import type { CropKind } from '../../../core/domain';
import { button, chip, empty, heading, slider } from '../../components/widgets';
import { h } from '../../core/dom';
import { icon } from '../../core/icons';
import { settlementCard } from '../../../sim/api';
import type { ManorPolicy } from '../../../sim/politics/types';
import { politicsRuntime } from '../../panels/politics';
import { cropName, cropOptions, fieldRoleWords, worksShareWords } from '../rulerModel';
import { line, type RulerEnv } from '../rulerUi';

const LEVELS: ReadonlyArray<readonly [number, string]> = [[-1, 'Relief'], [0, 'Customary'], [1, 'Heavy'], [2, 'Harsh']];

export function buildFields(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const v = env.view();
  const may = env.may();
  const pol = politicsRuntime(ctx);
  const wrap = h('div.mu-rul-page.mu-rul-fields');
  const places = v.settlements.filter((id) => (realm.cropPlanView?.(id) ?? []).length > 0 || pol);
  if (!may.plan) return empty('Your office does not order the fields.');
  wrap.append(h('p.mu-small.mu-ink2', { style: { margin: '0 0 12px' } },
    'In the three-field round each field is sown twice: winter corn in the autumn of its fallow year, a spring crop in the spring after. Name the crop for the next sowing; where none is named the usual rotation decides. The share of the serfs’ week-work sent to your building sites is taken from the demesne.'));

  const cards = places.map((id) => {
    const card = settlementCard(ctx.sim, id);
    const plan = realm.cropPlanView?.(id) ?? [];
    const share = realm.worksShare(id);
    const shareText = h('span.mu-small.mu-ink2', null, worksShareWords(share));
    const range = slider(0, 1, 0.05, share, (val) => { shareText.textContent = worksShareWords(val); });
    range.addEventListener('change', () => env.done(realm.setWorksShare(me, id, Number(range.value)), 'The share of week-work for the works is set.'));
    const fields = plan.map((f) => {
      const words = fieldRoleWords(f);
      const options = cropOptions(f);
      const sel = h<HTMLSelectElement>('select.mu-input', { 'aria-label': `Field ${f.field + 1}: crop for the next sowing` },
        h('option', { value: 'fallow', selected: f.planned === 'fallow' }, 'The usual rotation'),
        options.map((c) => h('option', { value: c, selected: f.planned === c }, cropName(c))));
      sel.addEventListener('change', () => env.done(realm.setCropPlan(me, id, f.field, sel.value as CropKind), sel.value === 'fallow' ? `Field ${f.field + 1} goes back to the usual rotation.` : `Field ${f.field + 1} will be sown with ${cropName(sel.value).toLowerCase()}.`));
      return h('div.mu-rul-field', null,
        h('div.mu-row.mu-between.mu-gap-8', null, h('b', null, `Field ${f.field + 1}`), chip(f.role === 'winter' ? 'winter corn' : f.role === 'spring' ? 'spring crop' : 'fallow', f.role === 'fallow' ? '' : 'green', 'wheat')),
        h('div.mu-tiny.mu-dim', null, words.now), h('div.mu-small.mu-ink2', null, words.next), sel);
    });
    // the manor's dues, labour and justice (the politics module's call)
    let policy: HTMLElement | null = null;
    if (pol) {
      const p = pol.manorPolicy(id);
      const unrest = pol.unrest(id);
      const select = (label: string, value: number, set: (n: number) => void): HTMLElement => {
        const s = h<HTMLSelectElement>('select.mu-input', { 'aria-label': label }, LEVELS.map(([n, l]) => h('option', { value: String(n), selected: n === value }, l)));
        s.addEventListener('change', () => set(Number(s.value)));
        return h('label.mu-rul-pol', null, h('span.mu-small', null, label), s);
      };
      const apply = (change: Partial<ManorPolicy>, ok: string): void => { env.done(pol.setManorPolicy(me, id, change), ok); };
      const justice = h<HTMLSelectElement>('select.mu-input', { 'aria-label': 'Local justice' }, [['lenient', 'Lenient'], ['fair', 'Fair'], ['harsh', 'Harsh']].map(([k, l]) => h('option', { value: k, selected: k === p.justice }, l)));
      justice.addEventListener('change', () => apply({ justice: justice.value as ManorPolicy['justice'] }, 'Justice is set.'));
      policy = h('div.mu-rul-policy', null,
        h('div.mu-row.mu-between', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'The manor’s dues'), chip(`unrest ${Math.round(unrest)}`, unrest > 60 ? 'vermilion' : unrest > 30 ? 'gold' : 'green', 'warning', 'Harsh dues enrich you and stir the villagers')),
        select('Rents and dues', p.rent, (n) => apply({ rent: n as ManorPolicy['rent'] }, 'The rents are set.')),
        select('Labour services', p.labour, (n) => apply({ labour: n as ManorPolicy['labour'] }, 'The labour services are set.')),
        h('label.mu-rul-pol', null, h('span.mu-small', null, 'Local justice'), justice));
    }
    return h('div.mu-card.mu-rul-place', null,
      h('div.mu-row.mu-between.mu-top', null, h('h4', null, card?.name ?? ctx.placeName(id)), card ? h('span.mu-small.mu-dim', null, `${card.population.toLocaleString('en-GB')} people`) : null),
      plan.length ? h('div.mu-grid.c3.mu-rul-fields3', null, fields) : line('This place has no open fields to plan.'),
      h('div.mu-rul-share', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Week-work sent to the works'), h('div.mu-row.mu-gap-12', null, range, shareText)),
      policy);
  });
  wrap.append(cards.length ? h('div.mu-col.mu-gap-12', null, cards) : empty('You rule no manor with fields to plan.'));
  wrap.append(heading('Your own household', 'home'),
    h('div.mu-row.mu-gap-8.mu-wrap', null,
      button('Household tasks', { icon: 'home', tip: 'Who in your household does what: the family page', onClick: () => ctx.open({ panel: 'family', tab: 'household' }) }),
      pol ? button('The full Command page', { icon: 'ledger', tip: 'Vassals, laws and the rest, in the realm and politics panel', onClick: () => ctx.open({ panel: 'ext', name: 'politics', data: { tab: 'manage' } }) }) : null));
  void icon;
  return wrap;
}
