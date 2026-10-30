// Culture-flavoured place names: settlements, kingdoms, counties. Deterministic given an Rng.
import type { CultureId, SettlementKind } from '../core/domain';
import type { Rng } from '../core/rng';

interface Table {
  /** first elements of compound names */
  stems: string[];
  /** endings for villages/hamlets */
  endings: string[];
  /** endings favoured for towns/cities */
  townEndings: string[];
  /** prefixes that attach to a stem (franc "Saint-", gael "Kil" etc.) with weight */
  prefixes: string[];
  /** extra whole-word names */
  words: string[];
}

const ANGLO: Table = {
  stems: ['Ash', 'Oak', 'Elm', 'Birch', 'Thorn', 'Hazel', 'Alder', 'Beech', 'Wood', 'Ley', 'Field', 'Marsh', 'Moor', 'Brook', 'Mill', 'Stone', 'Stan', 'Brad', 'Brom', 'Nor', 'Sud', 'East', 'West', 'Ex', 'Ayl', 'Cald', 'Cold', 'Chil', 'Win', 'Hart', 'Hare', 'Wolf', 'Fox', 'Cow', 'Ox', 'Ram', 'Swan', 'Crow', 'Rook', 'Hawk', 'Black', 'White', 'Red', 'Green', 'Grey', 'Long', 'High', 'Low', 'Deep', 'Broad', 'Fair', 'Sweet', 'Kings', 'Abbots', 'Bishops', 'Church', 'Bede', 'Cuth', 'Dun', 'Eald', 'Gil', 'Hod', 'Lind', 'Pad', 'Sand', 'Shef', 'Wal', 'Barn', 'Cran', 'Dal', 'Fen', 'Gos', 'Hol', 'Kirk', 'Lud', 'Mal', 'Pen', 'Rad', 'Sher', 'Tam', 'Ted', 'Wex', 'Yar', 'Bur', 'Chip', 'Alding', 'Hen', 'Wick', 'Thorp', 'Stock', 'Ket', 'Sal', 'Ald', 'Os', 'Wulf', 'Cyn', 'Aelf', 'Eth', 'Ing', 'Wyn', 'Hild', 'Ead'],
  endings: ['ton', 'ham', 'ley', 'bury', 'ford', 'wick', 'thorpe', 'field', 'worth', 'stead', 'well', 'combe', 'don', 'hurst', 'ing', 'by', 'stow', 'wood', 'cote', 'ey', 'lea', 'ford', 'ton', 'ham', 'ley', 'wick', 'bourne', 'wade', 'holt', 'ridge', 'low', 'thwaite'],
  townEndings: ['ford', 'bury', 'ton', 'chester', 'wick', 'ham', 'minster', 'mouth', 'bridge', 'port', 'stow'],
  prefixes: [], words: ['Winterbourne', 'Applecross', 'Greywater', 'Longmarsh', 'Kingsbridge'],
};
const FRANC: Table = {
  stems: ['Beau', 'Mont', 'Val', 'Bel', 'Clair', 'Fleur', 'Aubre', 'Vend', 'Roche', 'Pont', 'Chat', 'Mor', 'Lan', 'Berg', 'Gran', 'Fon', 'Mar', 'Lor', 'Sau', 'Tour', 'Ver', 'Cham', 'Dam', 'Brie', 'Chau', 'Ange', 'Poi', 'Lis', 'Ren', 'Ros', 'Sor', 'Aven', 'Gour', 'Vil', 'Cler', 'Tille', 'Orme', 'Chene', 'Haut', 'Basse', 'Verd', 'Blanc', 'Noir', 'Rouge', 'Cour', 'Plan', 'Vaux', 'Brume', 'Argent', 'Mauve'],
  endings: ['ville', 'court', 'mont', 'bourg', 'val', 'ac', 'ay', 'y', 'eux', 'ois', 'ières', 'mer', 'champ', 'lieu', 'fort', 'pré', 'ac', 'ville', 'court', 'mont'],
  townEndings: ['bourg', 'ville', 'mont', 'cy', 'ens', 'ance', 'ès', 'on'],
  prefixes: ['Saint-', 'Saint-', 'La ', 'Le ', 'Villeneuve-', 'Ste-'],
  words: ['Saint-Aubin', 'Beaulieu', 'Montfort', 'Villeneuve', 'Châteauneuf', 'Bellegarde'],
};
const GAEL: Table = {
  stems: ['Bal', 'Kil', 'Inver', 'Dun', 'Glen', 'Ard', 'Auch', 'Strath', 'Ben', 'Loch', 'Drum', 'Kin', 'Craig', 'Rath', 'Clon', 'Bally', 'Tul', 'Knock', 'Carrick', 'Dal', 'Glas', 'Mor', 'Tor', 'Ros', 'Lis', 'Dro', 'Kil', 'Ath', 'Cul', 'Ban', 'Dar', 'Fin', 'Gort', 'Inch', 'Lough', 'Moy', 'Slieve'],
  endings: ['more', 'mor', 'kirk', 'ness', 'bridge', 'cairn', 'lan', 'brae', 'aig', 'ach', 'ay', 'dale', 'rick', 'nan', 'gowan', 'mhor', 'avon', 'garry', 'tarf', 'quhar', 'ross'],
  townEndings: ['ness', 'more', 'bridge', 'kirk', 'dee', 'ness'],
  prefixes: ['Bal', 'Kil', 'Inver', 'Dun', 'Glen', 'Ard', 'Auch', 'Strath'],
  words: ['Dunmore', 'Ardmore', 'Glenmore', 'Killarney', 'Inverness'],
};
const CYMRIC: Table = {
  stems: ['Llan', 'Aber', 'Pen', 'Caer', 'Pont', 'Cwm', 'Tre', 'Bryn', 'Dol', 'Ysgol', 'Rhos', 'Maes', 'Nant', 'Glyn', 'Cefn', 'Garth', 'Tal', 'Hafod', 'Moel', 'Craig', 'Ffynnon', 'Gwern', 'Bod', 'Betws', 'Capel', 'Pwll', 'Llys', 'Mynydd'],
  endings: ['wen', 'fawr', 'ddu', 'goch', 'las', 'ydd', 'ior', 'og', 'wyn', 'llyn', 'garth', 'dwr', 'edd', 'ydd', 'mawr', 'bach', 'gof', 'tudwal', 'dyfi', 'arth'],
  townEndings: ['wen', 'fawr', 'dwr', 'ydd', 'mawr', 'ior'],
  prefixes: ['Llan', 'Aber', 'Pen', 'Caer', 'Pont', 'Cwm', 'Tre', 'Bryn', 'Dol'],
  words: ['Caerleon', 'Llangollen', 'Aberystwyth', 'Penmaen', 'Pontypridd'],
};
const NORSE: Table = {
  stems: ['Thor', 'Odin', 'Frey', 'Sig', 'Gun', 'Hal', 'Rag', 'Eir', 'Ulf', 'Bjorn', 'Skar', 'Vest', 'Ost', 'Nor', 'Sud', 'Kirk', 'Stor', 'Lang', 'Brand', 'Rav', 'Sten', 'Ask', 'Eng', 'Torn', 'Hav', 'Gran', 'Ber', 'Dal', 'Fjord', 'Holm', 'Sand', 'Ness', 'Vik', 'Tor', 'Eid', 'Rin', 'Lund', 'Sol', 'Gjer', 'Ulv', 'Hund', 'Hjort', 'Svart'],
  endings: ['by', 'thorp', 'vik', 'dal', 'ness', 'holm', 'stad', 'fjord', 'wick', 'toft', 'thwaite', 'gard', 'sund', 'berg', 'lund', 'ey', 'borg', 'vang', 'heim', 'by', 'vik', 'dal'],
  townEndings: ['vik', 'borg', 'by', 'ness', 'holm', 'sund', 'stad'],
  prefixes: [], words: ['Hammerfest', 'Ravnholm', 'Skarborg', 'Vestvik'],
};
const TEUTON: Table = {
  stems: ['Alt', 'Neu', 'Gross', 'Klein', 'Hohen', 'Nieder', 'Ober', 'Rhein', 'Wald', 'Berg', 'Stein', 'Eich', 'Linden', 'Birken', 'Rosen', 'Falken', 'Wolfs', 'Bären', 'Lauen', 'Frei', 'Schwarz', 'Weiss', 'Rot', 'Grün', 'Mühl', 'Burg', 'Hirsch', 'Kron', 'Lieb', 'Sonnen', 'Fried', 'Hain', 'Tann', 'Brun', 'Zeil', 'Heil', 'Hag', 'Wert', 'Dorn'],
  endings: ['burg', 'dorf', 'hausen', 'stadt', 'feld', 'bach', 'heim', 'wald', 'berg', 'au', 'ingen', 'stein', 'furt', 'brück', 'hof', 'rode', 'tal', 'see', 'kirchen', 'weiler', 'dorf', 'burg', 'hausen'],
  townEndings: ['burg', 'stadt', 'furt', 'brück', 'heim', 'berg', 'hausen'],
  prefixes: [], words: ['Freiburg', 'Neustadt', 'Altenburg', 'Rothenfels'],
};

const TABLES: Record<CultureId, Table> = { anglo: ANGLO, franc: FRANC, gael: GAEL, cymric: CYMRIC, norse: NORSE, teuton: TEUTON };

const KINGDOM_A: Record<CultureId, string[]> = {
  anglo: ['Mer', 'Nor', 'Wes', 'Ess', 'Sus', 'Ang', 'Bern', 'Deor', 'Lind', 'Elm', 'Hwic', 'Cent', 'Wyr', 'Dum', 'Ceol'],
  franc: ['Neus', 'Aqui', 'Bour', 'Lor', 'Pro', 'Gasc', 'Brit', 'Flan', 'Auv', 'Poit', 'Nor', 'Cham', 'Berr', 'Anj'],
  gael: ['Dal', 'Ard', 'Mor', 'Ross', 'Alb', 'Strath', 'Conn', 'Ul', 'Lein', 'Muma', 'Gall', 'Cait', 'Moy', 'Oir'],
  cymric: ['Gwyn', 'Pow', 'Dyf', 'Mor', 'Cered', 'Gwent', 'Brych', 'Rhe', 'Ystr', 'Mer', 'Dehe', 'Ard'],
  norse: ['Vest', 'Ost', 'Nor', 'Sud', 'Hald', 'Rog', 'Thron', 'Ska', 'Jam', 'Her', 'Mor', 'Sol'],
  teuton: ['Fran', 'Sach', 'Bay', 'Schwa', 'Thur', 'Hess', 'Loth', 'Brand', 'Wend', 'Fries', 'Alem', 'Böh'],
};
const KINGDOM_B: Record<CultureId, string[]> = {
  anglo: ['cia', 'sex', 'land', 'folk', 'bria', 'mark', 'wic', 'ia', 'ria', 'mere'],
  franc: ['tria', 'taine', 'gogne', 'raine', 'vence', 'gne', 'mandie', 'tagne', 'dre', 'ois', 'jou'],
  gael: ['riada', 'gael', 'ach', 'ster', 'nia', 'clyde', 'ay', 'ann', 'ness', 'mhan'],
  cymric: ['edd', 'ys', 'ion', 'ganwg', 'einiog', 'wg', 'ed', 'ynedd', 'ydd'],
  norse: ['fold', 'land', 'mark', 'heim', 'fjord', 'vik', 'ey', 'agder', 'mar'],
  teuton: ['konia', 'sen', 'ern', 'ben', 'ingen', 'ringen', 'burg', 'land', 'mark', 'ien'],
};

const COUNTY_SUFFIX: Record<CultureId, string[]> = {
  anglo: ['shire', 'shire', 'sex', 'folk', 'ham'],
  franc: ['ois', 'ais', 'ac', 'ay'],
  gael: ['shire', 'more', 'ach', 'sheen'],
  cymric: ['ion', 'wg', 'edd', 'ys'],
  norse: ['land', 'fylke', 'marken', 'heim'],
  teuton: ['gau', 'land', 'mark', 'ingen'],
};

const SAINTS: Record<CultureId, string[]> = {
  anglo: ['Aldhelm', 'Cuthbert', 'Edmund', 'Bede', 'Oswald', 'Alban', 'Wilfrid', 'Dunstan', 'Swithun', 'Chad', 'Hilda', 'Etheldreda', 'Frideswide', 'Mildred', 'Werburgh'],
  franc: ['Aubin', 'Denis', 'Martin', 'Remi', 'Germain', 'Leger', 'Vaast', 'Maur', 'Benoit', 'Hilaire', 'Radegonde', 'Clotilde', 'Geneviève'],
  gael: ['Columba', 'Brendan', 'Kieran', 'Brigid', 'Ninian', 'Mungo', 'Fillan', 'Aidan', 'Colman', 'Finnian', 'Enda'],
  cymric: ['David', 'Teilo', 'Cadoc', 'Asaph', 'Dyfrig', 'Illtyd', 'Beuno', 'Winifred', 'Dwynwen', 'Padarn'],
  norse: ['Olaf', 'Magnus', 'Knut', 'Sunniva', 'Botolf', 'Hallvard', 'Eskil', 'Ansgar', 'Erik'],
  teuton: ['Bonifatius', 'Gallus', 'Emmeram', 'Kilian', 'Ulrich', 'Lambert', 'Willibrord', 'Walburga', 'Hildegard', 'Otmar'],
};

const CASTLE_PREFIX: Record<CultureId, string[]> = {
  anglo: ['Castle ', ''], franc: ['Château ', 'Château de '], gael: ['Dun ', 'Castle '], cymric: ['Castell ', 'Caer '], norse: ['', ''], teuton: ['Burg ', 'Schloss '],
};
const CASTLE_SUFFIX: Record<CultureId, string[]> = {
  anglo: [' Castle', ' Castle', ' Keep'], franc: ['', ''], gael: [' Castle', ''], cymric: ['', ''], norse: ['borg', 'holm', 'borg'], teuton: ['stein', 'burg', 'fels'],
};

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function join(a: string, b: string): string {
  // avoid triple letters and awkward doubles at the seam
  if (a.length && b.length && a[a.length - 1].toLowerCase() === b[0].toLowerCase() && /[aeiou]/i.test(b[0])) return a + b.slice(1);
  if (a.length >= 2 && b.length && a[a.length - 1] === b[0] && a[a.length - 2] === b[0]) return a + b.slice(1);
  return a + b;
}

function stemName(c: CultureId, rng: Rng, endings: string[]): string {
  const t = TABLES[c];
  let stem = rng.pick(t.stems);
  let ending = rng.pick(endings);
  // gaelic/cymric prefix-names behave as stems already; avoid stem == ending duplication
  if (stem.toLowerCase() === ending.toLowerCase()) ending = rng.pick(endings);
  // franc "Saint-" and "La/Le" forms
  if (c === 'franc' && rng.chance(0.18)) return rng.pick(t.prefixes) + cap(join(stem, rng.pick(['', 'y', 'ac', 'ay', 'on', 'eux'])));
  if (c === 'gael' && /^(Bal|Kil|Inver|Dun|Glen|Ard|Auch|Strath|Ben|Loch|Drum|Kin|Craig)$/.test(stem)) ending = rng.pick(['more', 'ness', 'dale', 'aig', 'brae', 'lan', 'nan', 'garry', 'avon', 'ross', 'kirk', 'cairn']);
  if (c === 'cymric' && /^(Llan|Aber|Pen|Caer|Pont|Cwm|Tre|Bryn|Dol)$/.test(stem)) {
    const tail = rng.pick(['Dewi', 'Mawr', 'Fawr', 'Gwyn', 'Cadog', 'Elen', 'Beris', 'Tegid', 'Rhiw', 'Dwr', 'Wen', 'Las']);
    return stem + tail.toLowerCase();
  }
  return cap(join(stem, ending));
}

export function settlementName(culture: CultureId, kind: SettlementKind, rng: Rng, used: Set<string>): string {
  const t = TABLES[culture];
  for (let attempt = 0; attempt < 40; attempt++) {
    let name: string;
    switch (kind) {
      case 'city':
        name = stemName(culture, rng, t.townEndings);
        break;
      case 'town':
        name = stemName(culture, rng, t.townEndings);
        break;
      case 'castle': {
        const base = stemName(culture, rng, t.endings);
        const pre = rng.pick(CASTLE_PREFIX[culture]);
        const suf = rng.pick(CASTLE_SUFFIX[culture]);
        if (culture === 'norse' || culture === 'teuton') name = pre + cap(join(rng.pick(t.stems), suf));
        else name = pre ? pre + base : base + suf;
        break;
      }
      case 'abbey': case 'priory': case 'nunnery': {
        const saint = rng.pick(SAINTS[culture]);
        const useSaint = rng.chance(0.4);
        const base = useSaint ? saint : stemName(culture, rng, t.endings);
        const noun = kind === 'abbey' ? 'Abbey' : kind === 'priory' ? 'Priory' : 'Nunnery';
        switch (culture) {
          case 'franc': name = `${kind === 'abbey' ? 'Abbaye' : kind === 'priory' ? 'Prieuré' : 'Couvent'} ${useSaint ? 'Saint-' : 'de '}${base}`; break;
          case 'teuton': name = useSaint ? `Kloster St. ${base}` : `Kloster ${base}`; break;
          case 'cymric': name = `${kind === 'abbey' ? 'Abaty' : 'Priordy'} ${base}`; break;
          case 'norse': name = `${base} Kloster`; break;
          default: name = useSaint ? `St ${base}'s ${noun}` : `${base} ${noun}`;
        }
        break;
      }
      case 'hamlet': {
        name = stemName(culture, rng, t.endings);
        if (culture === 'anglo' && rng.chance(0.25)) name = rng.pick(['Little ', 'Nether ', 'Upper ', 'Lower ', 'Old ', 'New ']) + name;
        break;
      }
      default: // village
        name = rng.chance(0.04) ? rng.pick(t.words) : stemName(culture, rng, t.endings);
        if (culture === 'anglo' && rng.chance(0.07)) name = rng.pick(['Great ', 'Long ', 'Church ', 'Kings ', 'Abbots ']) + name;
    }
    if (!used.has(name)) { used.add(name); return name; }
  }
  // disambiguate
  const base = stemName(culture, rng, t.endings);
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base} ${['', 'Minor', 'Parva', 'Magna', 'Upper', 'Nether'][i % 6]}${i > 6 ? ' ' + i : ''}`.trim();
  used.add(name);
  return name;
}

export function kingdomName(culture: CultureId, rng: Rng, used: Set<string>): string {
  for (let attempt = 0; attempt < 40; attempt++) {
    const name = cap(join(rng.pick(KINGDOM_A[culture]), rng.pick(KINGDOM_B[culture])));
    if (!used.has(name)) { used.add(name); return name; }
  }
  const name = cap(rng.pick(KINGDOM_A[culture])) + 'ia' + used.size;
  used.add(name);
  return name;
}

export function countyName(culture: CultureId, rng: Rng, used: Set<string>): string {
  for (let attempt = 0; attempt < 40; attempt++) {
    const t = TABLES[culture];
    const stem = rng.chance(0.5) ? rng.pick(t.stems) : rng.pick(KINGDOM_A[culture]);
    const name = cap(join(stem.replace(/-$/, ''), rng.pick(COUNTY_SUFFIX[culture])));
    if (!used.has(name)) { used.add(name); return name; }
  }
  const name = `County ${used.size}`;
  used.add(name);
  return name;
}
