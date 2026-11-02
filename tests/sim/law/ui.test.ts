// The law's screens as pure models (no DOM here): the card of a patrol that has halted you, the prisoner's card, the escort's countdown,
// and the HUD plaque of whose land you stand on. The panels and the HUD part are built from these.
import { describe, expect, it } from 'vitest';
import { formatMoney } from '../../../src/sim/money';
import type { CaptivityView, LawChoice, PatrolView } from '../../../src/sim/law/types';
import { extPanel } from '../../../src/ui/panels/extRegistry';
import { hudPartFactories } from '../../../src/ui/core/extHud';
import { askedText, captiveCard, closedText, daysHeld, escortText, freeCard, patrolCard } from '../../../src/ui/panels/law';
import { bearingTo, bearingWord, plaque, type PlaqueInput } from '../../../src/ui/hud/law';
import '../../../src/ui/panels/ext';

const patrol = (o: Partial<PatrolView> = {}): PatrolView => ({
  id: 1, leader: 10, men: [11, 12], house: 3, settlement: 4, target: 99, phase: 'halt', line: 'Halt. You are on the lands of Sir Hugh. State your business or be gone.',
  deadline: Infinity, level: 'private', reason: "the lord's deer park at Cyney", lord: 'Sir Hugh', leaderName: 'Sergeant Wat Harper', mounted: true, ...o,
});

const captive = (o: Partial<CaptivityView> = {}): CaptivityView => ({
  person: 99, kind: 'poaching', captor: 10, house: 3, settlement: 4, building: 7, since: 5.3, ransom: 0, fine: 18, sentenceDays: 2,
  text: "Held in the gaol of Dromore for poaching the lord's deer.", danger: false, place: 'the gaol of Dromore', ...o,
});

const offered: LawChoice[] = [
  { id: 'leave', label: 'Leave the land', detail: 'They will see you to the edge', ok: true },
  { id: 'business', label: 'State your business', ok: true },
  { id: 'bribe', label: 'Offer a bribe', detail: '8d', ok: false, reason: 'You have no money to offer' },
  { id: 'refuse', label: 'Refuse', ok: true },
];

describe('the module registers its screens', () => {
  it('the law panel and the HUD plaque are found by the interface', () => {
    expect(extPanel('law')).toBeTypeOf('function');
    expect(hudPartFactories().has('law')).toBe(true);
  });
});

describe('the card of a patrol', () => {
  it('shows the leader\'s words, why the land is closed, who is come, and numbers the answers 1 to n', () => {
    const c = patrolCard(patrol(), offered);
    expect(c.kind).toBe('patrol');
    expect(c.title).toBe('Halted');
    expect(c.subtitle).toBe('The lands of Sir Hugh');
    expect(c.quote).toMatch(/^Halt\. You are on the lands of Sir Hugh/);
    expect(c.facts[0]).toBe("The lord's deer park at Cyney.");
    expect(c.facts[1]).toBe('Sergeant Wat Harper and 2 men, mounted.');
    expect(c.choices.map((x) => [x.key, x.id, x.enabled])).toEqual([['1', 'leave', true], ['2', 'business', true], ['3', 'bribe', false], ['4', 'refuse', true]]);
    expect(c.choices[2].reason).toBe('You have no money to offer');
    // leaving is the way offered first; refusing is marked as the dangerous answer
    expect(c.choices[0].tone).toBe('primary');
    expect(c.choices[3].tone).toBe('danger');
  });

  it('says foot or horse, one man, game on you, and — at war — that the enemy is not heard', () => {
    expect(patrolCard(patrol({ men: [11], mounted: false }), []).facts[1]).toBe('Sergeant Wat Harper and 1 man on foot.');
    expect(patrolCard(patrol({ poaching: true }), []).facts).toContain('They have found game or a hunting bow on you.');
    const war = patrolCard(patrol({ level: 'hostile', skipTalk: true, reason: 'lands of House Avenel, at war with yours', lord: 'House Avenel' }), []);
    expect(war.title).toBe('Hostile land');
    expect(war.icon).toBe('swords');
    expect(war.facts[0]).toBe('Lands of House Avenel, at war with yours.');
    expect(war.facts.join(' ')).toMatch(/yield, or fight/);
  });

  it('closedText falls back to the plain words when the territory gave no reason', () => {
    expect(closedText(patrol({ reason: undefined }))).toBe("The lord's private land.");
    expect(closedText(patrol({ reason: undefined, level: 'hostile' }))).toBe('Hostile land.');
  });
});

describe('the prisoner\'s card', () => {
  it('says where he is held, since when, what is asked and how long, and offers the ways out', () => {
    const c = captiveCard(captive(), [{ id: 'wait', label: 'Wait for your family', ok: true }, { id: 'pay', label: 'Pay the fine', ok: false, reason: 'You cannot raise it' }], 8.1, 'Sir Hugh');
    expect(c.kind).toBe('captive');
    expect(c.title).toBe('Prisoner');
    expect(c.subtitle).toBe('the gaol of Dromore');
    expect(c.quote).toMatch(/^Held in the gaol of Dromore/);
    expect(c.facts[0]).toMatch(/^Held by Sir Hugh since .* \(3 days\)\.$/);
    expect(c.facts).toContain(`Fine owed: ${formatMoney(18)}.`);
    expect(c.facts.some((f) => /2 days of labour/.test(f))).toBe(true);
    expect(c.facts.at(-1)).toMatch(/Sleep or wait/);
    expect(c.choices.map((x) => x.key)).toEqual(['1', '2']);
    expect(c.warning).toBeUndefined();
  });

  it('a prisoner of war is asked a ransom, not a fine or a sentence', () => {
    const v = captive({ kind: 'war', war: true, ransom: 450, fine: 0, sentenceDays: 0, text: 'Held prisoner in the keep of Dun Balross.' });
    const lines = askedText(v);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^Ransom asked: ${formatMoney(450).replace('£', '\\£')}`));
  });

  it('serving a sentence, being led, and the warning of the rope', () => {
    expect(askedText(captive({ serving: true, sentenceDays: 1 })).some((l) => /serving your sentence: 1 day of labour left/.test(l))).toBe(true);
    const led = captiveCard(captive({ led: true, building: -1, text: "Bound and led to the manor's lock-up at Linwell for trespass." }), [], 6, 'Wat Harper');
    expect(led.title).toBe('Taken');
    expect(led.facts[0]).toMatch(/^Taken by Wat Harper/);
    const hanged = captiveCard(captive({ danger: true }), [], 6, 'Sir Hugh');
    expect(hanged.warning).toMatch(/hang you at dawn/);
  });

  it('counts whole days from the day taken', () => {
    expect(daysHeld(captive({ since: 5.9 }), 5.99)).toBe(0);
    expect(daysHeld(captive({ since: 5.9 }), 6.0)).toBe(1);
    expect(daysHeld(captive({ since: 5.9 }), 12.2)).toBe(7);
    expect(daysHeld(captive({ since: 9 }), 4)).toBe(0);
  });

  it('there is a card for being free too (it closes itself)', () => {
    const f = freeCard();
    expect(f.kind).toBe('free');
    expect(f.choices).toEqual([]);
  });
});

describe('the escort\'s countdown', () => {
  it('counts the seconds left to be off the land, up, and says nothing when there is no deadline', () => {
    expect(escortText(patrol({ phase: 'escort', deadline: 41.2 }))).toBe('Off the land in 42 s');
    expect(escortText(patrol({ phase: 'escort', deadline: 0.01 }))).toBe('Off the land in 1 s');
    expect(escortText(patrol({ phase: 'escort', deadline: -3 }))).toBe('Off the land in 0 s');
    expect(escortText(patrol())).toBe('');
  });
});

describe('the compass of the plaque', () => {
  it('names the way to the edge of the land (north is -z, east is +x)', () => {
    expect(bearingWord(bearingTo(0, 0, 0, -100))).toBe('north');
    expect(bearingWord(bearingTo(0, 0, 100, 0))).toBe('east');
    expect(bearingWord(bearingTo(0, 0, 0, 100))).toBe('south');
    expect(bearingWord(bearingTo(0, 0, -100, 0))).toBe('west');
    expect(bearingWord(bearingTo(0, 0, 70, -70))).toBe('north-east');
    expect(bearingWord(bearingTo(0, 0, -70, 70))).toBe('south-west');
    expect(bearingWord(-0.01)).toBe('north');
  });
});

describe('the plaque', () => {
  const base: PlaqueInput = { trespass: null, patrol: null, captive: null, restraint: null, horse: null, exit: null };

  it('is empty when there is nothing to say', () => {
    expect(plaque(base)).toBeNull();
  });

  it('says whose land it is when it is not yours: private, then hostile', () => {
    const p = plaque({ ...base, trespass: { level: 'private', reason: "the lord's deer park at Cyney", lord: 'Sir Hugh' } })!;
    expect(p).toMatchObject({ kind: 'land', tone: 'gold', title: 'Lands of Sir Hugh · private', sub: "The lord's deer park at Cyney.", action: null });
    const h = plaque({ ...base, trespass: { level: 'hostile', reason: 'lands of House Avenel, at war with yours', lord: 'Lord Avenel', hostileHouse: 'House Avenel, at war with yours' } })!;
    expect(h).toMatchObject({ kind: 'land', tone: 'vermilion', title: 'Hostile: House Avenel, at war with yours' });
  });

  it('warns of the riders, then of the halt (with the button to answer), then counts the escort with the way out', () => {
    expect(plaque({ ...base, patrol: patrol({ phase: 'coming' }) })).toMatchObject({ kind: 'coming', title: 'Riders are coming', action: null });
    expect(plaque({ ...base, patrol: patrol({ phase: 'coming', level: 'hostile' }) })!.sub).toMatch(/hostile House/);
    const halt = plaque({ ...base, patrol: patrol({ phase: 'halt' }) })!;
    expect(halt).toMatchObject({ kind: 'coming', action: 'Answer them' });
    expect(halt.sub).toMatch(/^Halt\./);
    const esc = plaque({ ...base, patrol: patrol({ phase: 'escort', deadline: 37.4 }), exit: { metres: 212.6, bearing: Math.PI / 2 } })!;
    expect(esc).toMatchObject({ kind: 'escort', title: 'Off the land in 38 s', sub: '213 m to the edge, east' });
    expect(plaque({ ...base, patrol: patrol({ phase: 'attack' }) })!.title).toBe('They are on you');
  });

  it('the patrol outranks the land, and being held outranks the patrol', () => {
    const land: PlaqueInput['trespass'] = { level: 'private', reason: 'x', lord: 'Sir Hugh' };
    expect(plaque({ ...base, trespass: land, patrol: patrol({ phase: 'coming' }) })!.kind).toBe('coming');
    const held = plaque({ ...base, trespass: land, patrol: patrol({ phase: 'coming' }), captive: captive() })!;
    expect(held.kind).toBe('held');
    expect(held.title).toBe('Held in the gaol of Dromore');
    expect(held.sub).toBe(`Fine owed: ${formatMoney(18)}`);
    expect(held.action).toBe('Your options');
  });

  it('a prisoner shows his ransom, his sentence, or the rope', () => {
    expect(plaque({ ...base, captive: captive({ kind: 'war', war: true, ransom: 450, fine: 0 }) })!.sub).toBe(`Ransom asked: ${formatMoney(450)}`);
    expect(plaque({ ...base, captive: captive({ serving: true, sentenceDays: 1 }) })!.sub).toBe('Serving: 1 day left');
    expect(plaque({ ...base, captive: captive({ danger: true }) })!.sub).toBe('The lord may hang you.');
  });

  it('a man being led is told to keep up; a restraint with no case behind it is only named', () => {
    const led = plaque({ ...base, captive: captive({ led: true, building: -1 }), restraint: { kind: 'led', by: 10, reason: 'Bound and led to the lock-up.' } })!;
    expect(led).toMatchObject({ kind: 'bound', title: 'Bound and led to the lock-up.', action: 'Your options' });
    expect(led.sub).toMatch(/Keep up/);
    expect(plaque({ ...base, restraint: { kind: 'held', x: 0, z: 0, building: 7, reason: 'In the cell.' } })).toMatchObject({ kind: 'bound', action: null });
  });

  it('the horse that was called is the last thing the plaque says', () => {
    expect(plaque({ ...base, horse: { eta: 14 } })).toMatchObject({ kind: 'horse', title: 'Your horse is coming', sub: 'About 14 s' });
    expect(plaque({ ...base, horse: { eta: 0 } })!.sub).toBe('It is here');
    expect(plaque({ ...base, horse: { eta: 14 }, trespass: { level: 'private', reason: 'x', lord: 'Sir Hugh' } })!.kind).toBe('land');
  });
});
