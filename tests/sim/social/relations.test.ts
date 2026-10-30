import { describe, expect, it } from 'vitest';
import type { Person } from '../../../src/sim/state';
import { makePlayer, mkHouse, mkPerson, rig, villager, type Rig } from './helpers';

interface Family { grandfather: Person; father: Person; mother: Person; uncle: Person; cousin: Person; me: Person; brother: Person; sister: Person; wife: Person; fatherInLaw: Person }

function family(r: Rig): Family {
  const hh = r.sim.state.households.get(villager(r).household)!;
  const grandfather = mkPerson(r.sim, { sex: 'm', age: 66, household: hh.id, byname: 'Cole' });
  const father = mkPerson(r.sim, { sex: 'm', age: 40, household: hh.id, father: grandfather, byname: 'Cole' });
  const mother = mkPerson(r.sim, { sex: 'f', age: 38, household: hh.id, byname: 'Cole' });
  r.sim.state.marry(father, mother, 0);
  const uncle = mkPerson(r.sim, { sex: 'm', age: 35, father: grandfather, byname: 'Cole' });
  const cousin = mkPerson(r.sim, { sex: 'f', age: 12, father: uncle, byname: 'Cole' });
  const me = mkPerson(r.sim, { sex: 'm', age: 17, household: hh.id, father, mother, byname: 'Cole' });
  const brother = mkPerson(r.sim, { sex: 'm', age: 14, household: hh.id, father, mother, byname: 'Cole' });
  const sister = mkPerson(r.sim, { sex: 'f', age: 19, household: hh.id, father, mother, byname: 'Cole' });
  const fatherInLaw = mkPerson(r.sim, { sex: 'm', age: 50, byname: 'Wright' });
  const wife = mkPerson(r.sim, { sex: 'f', age: 20, father: fatherInLaw, byname: 'Wright' });
  r.sim.state.marry(me, wife, 0);
  r.sim.state.setHead(hh, father);
  makePlayer(r.sim, me);
  return { grandfather, father, mother, uncle, cousin, me, brother, sister, wife, fatherInLaw };
}

describe('relations and labels', () => {
  it('lists a family with the right kinds and labels', () => {
    const r = rig({ seed: 'rel-fam' });
    const f = family(r);
    const rels = r.social.relations(f.me.id);
    const by = (p: Person) => rels.find((x) => x.person === p.id);
    expect(by(f.wife)?.kinds).toContain('spouse');
    expect(by(f.wife)?.label).toBe('your wife');
    expect(by(f.father)?.kinds).toContain('parent');
    expect(by(f.father)?.label).toBe('your father');
    expect(by(f.mother)?.label).toBe('your mother');
    expect(by(f.brother)?.kinds).toContain('sibling');
    expect(by(f.sister)?.label).toBe('your sister');
    expect(by(f.grandfather)?.kinds).toContain('kin');
    expect(by(f.grandfather)?.label).toBe('your grandfather');
    expect(by(f.uncle)?.label).toBe('your uncle');
    expect(by(f.cousin)?.label).toBe('your cousin');
    expect(by(f.fatherInLaw)?.kinds).toContain('in_law');
    expect(by(f.fatherInLaw)?.label).toBe('your father-in-law');
    // closest ties come first
    expect(rels[0].kinds).toContain('spouse');
    expect(rels.findIndex((x) => x.kinds.includes('parent'))).toBeLessThan(rels.findIndex((x) => x.person === f.cousin.id));
    // each entry carries both directions of feeling
    for (const x of rels) {
      expect(x.myOpinion).toBe(r.social.opinion(f.me.id, x.person));
      expect(x.theirOpinion).toBe(r.social.opinion(x.person, f.me.id));
    }
  });

  it('says "his/her" for someone other than the player and puts the viewer\'s name first', () => {
    const r = rig({ seed: 'rel-npc' });
    const f = family(r);
    expect(r.social.relationLabel(f.father.id, f.me.id)).toBe("Cole's son".replace('Cole', f.father.first));
    expect(r.social.relationLabel(f.me.id, f.brother.id)).toBe('your brother');
    expect(r.social.relationLabel(f.brother.id, f.sister.id)).toBe(`${f.brother.first}'s sister`);
  });

  it('describes non-kin by office or trade, or as a stranger', () => {
    const r = rig({ seed: 'rel-roles' });
    const f = family(r);
    const reeve = villager(r, { sex: 'm', age: 45, career: 'farmer' });
    reeve.offices.push({ office: 'reeve', place: reeve.settlement, since: 0 });
    const alewife = villager(r, { sex: 'f', age: 35, career: 'alewife' });
    const far = villager(r, { sex: 'm', age: 30, settlement: r.sim.world.settlements.find((s) => s.id !== f.me.settlement && s.kind === 'village')!.id });
    expect(r.core.relations.describe(f.me, reeve, false)).toBe('the reeve');
    expect(r.social.relationLabel(f.me.id, alewife.id)).toBe(`${alewife.first}, an alewife`);
    expect(r.core.relations.describe(f.me, far, false)).toMatch(/^a stranger from /);
  });

  it('knows lords and vassals from titles, masters and apprentices from households', () => {
    const r = rig({ seed: 'rel-titles' });
    const st = r.sim.state;
    const me = r.player;
    const title = r.core.lordTitleOf(me.settlement);
    if (title && title.holder && title.holder !== me.id) {
      const lord = st.persons.get(title.holder)!;
      expect(r.social.relations(me.id).find((x) => x.person === lord.id)?.kinds).toContain('lord');
      expect(r.social.relationLabel(me.id, lord.id)).toBe('your lord');
      expect(r.core.relations.kinds(lord, me)).toContain('vassal');
    }
    const master = villager(r, { sex: 'm', age: 45, career: 'smith' });
    master.careerStage = 2;
    const hh = st.households.get(master.household)!;
    const house = st.houses.get(master.house)!;
    const boy = mkPerson(r.sim, { sex: 'm', age: 14, career: 'smith', household: hh.id, house: house.id });
    boy.careerStage = 0;
    house.sworn.push(boy.id);
    const rels = r.social.relations(boy.id);
    expect(rels.find((x) => x.person === master.id)?.kinds).toContain('master');
    expect(r.social.relationLabel(boy.id, master.id)).toBe(`${boy.first}'s master`);
    expect(r.social.relations(master.id).find((x) => x.person === boy.id)?.kinds).toContain('apprentice');
  });

  it('finds friends, rivals and enemies in what people think of each other', () => {
    const r = rig({ seed: 'rel-feel' });
    const a = villager(r), friend = villager(r), rival = villager(r), enemy = villager(r);
    r.social.adjustOpinion(a.id, friend.id, 40, 'chat'); r.social.adjustOpinion(friend.id, a.id, 40, 'chat');
    r.social.adjustOpinion(a.id, rival.id, -(30 + r.core.opinion.base(a, rival)), 'insult');
    r.social.adjustOpinion(a.id, enemy.id, -(70 + r.core.opinion.base(a, enemy)), 'insult');
    const rels = r.social.relations(a.id);
    const kinds = (p: Person) => rels.find((x) => x.person === p.id)?.kinds ?? [];
    expect(kinds(friend)).toContain('friend');
    expect(kinds(rival)).toContain('rival');
    expect(kinds(enemy)).toContain('enemy');
    expect(r.social.relationLabel(a.id, friend.id)).toBe(`${a.first}'s friend`);
    expect(r.social.relationLabel(r.player.id, r.player.id)).toBe('');
  });

  it('lists a few neighbours by the street they live on', () => {
    const r = rig({ seed: 'rel-street' });
    const rels = r.social.relations(r.player.id);
    const n = rels.filter((x) => x.kinds.includes('neighbour'));
    expect(n.length).toBeGreaterThan(0);
    expect(n.length).toBeLessThanOrEqual(6);
    mkHouse(r.sim); // keep the builder import used
  });
});
