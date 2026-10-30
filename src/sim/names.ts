// Culture-appropriate person names (SPEC §3 cultures). First names by sex; bynames of four kinds:
// occupational (Smith, Miller …), patronymic (-son, Fitz-, Mac/Mc-, ap/ab, -sen/-sson), locative
// ("of <settlement>") and noble house names. Lists are real medieval-style names; no randomness
// beyond the Rng passed in.
import type { CultureId, Sex } from '../core/domain';
import type { Rng } from '../core/rng';
import type { CareerId } from './careers';

interface CultureNames {
  male: string[];
  female: string[];
  /** Names of the old noble houses. */
  houses: string[];
  /** Nicknames and misc. bynames for commoners. */
  misc: string[];
  /** Occupational bynames by career. */
  trades: Partial<Record<CareerId, string[]>>;
  /** How patronymics work in this culture. */
  patronymic: 'none' | 'son' | 'sson' | 'ap' | 'mac';
  /** Chance a commoner has a patronymic byname (when the style exists). */
  patronymicShare: number;
  /** Chance a commoner has a locative byname. */
  locativeShare: number;
  /** Locative connector ("of", "de", "von"). */
  locative: string;
}

const w = (s: string): string[] => s.split(/\s+/).filter(Boolean).map((x) => x.replace(/_/g, ' '));

const NAMES: Record<CultureId, CultureNames> = {
  anglo: {
    male: w(`William John Thomas Richard Robert Henry Walter Hugh Roger Geoffrey Simon Adam Ralph Nicholas Peter
      Edmund Edward Alan Gilbert Stephen Godfrey Osbert Gervase Baldwin Aldred Alfred Edric Leofric Wulfstan Godwin
      Oswald Cuthbert Hamo Jocelin Humphrey Reynold Philip Miles Giles Ranulf Warin Everard Bartholomew Matthew Martin
      Lawrence Elias Jordan Thurstan Osmund Hubert Odo Gregory Ivo Fulk Herbert Hereward Aubrey Maurice Piers Tobias
      Wymond Eustace Gavin Edgar Harold Leofwin Ailmer Brian Colin Dickon Hob Jankin Perkin Wat Tibbald`),
    female: w(`Alice Agnes Matilda Joan Margaret Isabel Emma Cecily Edith Eleanor Beatrice Juliana Maud Katherine
      Margery Mabel Amice Avice Sibyl Rose Denise Ela Idonea Petronilla Godiva Hawise Christina Elena Gunnild Sarah
      Lucy Mary Elizabeth Anne Ellen Annora Basilia Constance Dionisia Felice Gillian Helewise Joyce Lettice
      Millicent Nesta Olive Parnel Rohese Sabina Thomasin Wymarc Cassandra Eve Florence Hilda Letitia Mildred
      Osanna Philippa Quenild Rosamund Sunniva Ursula Winifred Aldith Bertha Elfreda`),
    houses: w(`Percy Neville Mowbray Beauchamp Clifford Courtenay Montagu Talbot Stafford Bohun Despenser Mortimer
      Grey FitzAlan Berkeley Dacre Lovel Audley Ferrers Warenne Umfraville Tiptoft Pole Scrope Hastings Brewse
      Camoys Cobham Furnival Greystoke Harcourt Latimer Zouche Poynings Willoughby Basset de_Vere
      FitzWalter FitzHugh FitzWilliam FitzGerald FitzRoy`),
    misc: w(`Brown White Black Long Short Young Old Little Good Bright Fair Swift Strong Sharp Hardy Gold Wise Hind
      Cole Fox Wolf Lamb Finch Wren Crow Rook Hawk Dove Bird Swan Hart Bull Hogg Kidd Lamb Wood Hill Brook
      Green Marsh Field Ford Bridge Stone Thorne Ash Oakley Fletcher Peacock`),
    trades: {
      smith: w('Smith Smyth Goldsmith Arkwright'), carpenter: w('Carpenter Wright Joiner'),
      mason: w('Mason Masson Stonor'), tanner: w('Tanner Skinner Barker'), weaver: w('Webster Weaver Webb'),
      tailor: w('Taylor Tailor Sewell'), baker: w('Baker Bakster'), miller: w('Miller Milner Mellor'),
      butcher: w('Butcher Fleshewer Bowman'), cooper: w('Cooper Hooper Cowper'), cobbler: w('Cobbler Shoemaker Cordwainer'),
      potter: w('Potter Crocker'), fuller: w('Fuller Walker Tucker'), chandler: w('Chandler Waxman'),
      wheelwright: w('Wheeler Wainwright Cartwright'), saddler: w('Sadler Saddler Lorimer'), fisher: w('Fisher Fysher Piper'),
      shepherd: w('Shepherd Shepard Lambert'), swineherd: w('Swain Hogg Gooderham'), farmer: w('Plowman Husband Hayward Reeve'),
      labourer: w('Carter Thatcher Sawyer Slater Tyler'), woodward: w('Woodward Forester Parker'),
      merchant: w('Mercer Chapman Draper Marchant Spicer'), alewife: w('Brewster Brewer Alewife'),
      priest: w('Clerk Parsons Priest'), servant: w('Page Garland Butler'), soldier: w('Archer Bowyer Fletcher Bowman'),
      yeoman: w('Yeoman Frankeleyn Freeman'),
    },
    patronymic: 'son', patronymicShare: 0.2, locativeShare: 0.18, locative: 'of',
  },
  franc: {
    male: w(`Guillaume Jean Pierre Henri Robert Hugues Raoul Thibaut Gautier Geoffroi Renaud Baudouin Etienne Aymeri
      Bertrand Foulques Gaucher Gui Jourdain Lambert Mathieu Olivier Roland Savary Tristan Yves Arnaud Bernard
      Charles Louis Philippe Alain Anselme Eudes Gilles Guerin Lucien Amaury Thierry Josselin Hamon Clement
      Aubert Benoit Denis Gervais Huon Jacques Lucas Martin Nicolas Remi Simon Simonet Colin Perrin Jehan`),
    female: w(`Alienor Mathilde Isabelle Jeanne Marguerite Blanche Agnes Beatrice Aelis Ermengarde Helene Ide Jacquette
      Mahaut Perrette Sibylle Alix Clemence Colette Eleonore Gisele Guillemette Heloise Ysabeau Jehanne Marie
      Catherine Philippa Adeline Amelie Berengere Constance Denise Emeline Genevieve Hersende Isolde Liesse
      Melisende Odette Pernelle Richilde Sancie Tiphaine Yolande Agathe Aveline Basilie Cecile`),
    houses: w(`de_Montfort de_Beaumont de_Courcy de_Vermandois de_Lusignan de_Coucy de_Clermont de_Rohan
      de_Montmorency de_Vendome d'Harcourt de_Craon de_Sully de_Ponthieu de_Blois de_Dreux de_Joinville
      de_Mauleon de_Tancarville de_Bourbon de_Châtillon de_Roucy de_Rethel de_Nevers de_Bar`),
    misc: w(`Leblanc Lenoir Legrand Petit Lebrun Leroux Lejeune Lefort Doux Bonnet Gaillard Hardi Joli Morel Renard
      Loup Lepage Lamy Fontaine Dubois Dupont Dumont Duval Laforge Lacroix Beaulieu Larue`),
    trades: {
      smith: w('Lefevre Fevre Fournier Forgeron'), carpenter: w('Charpentier Menuisier'), mason: w('Macon Massot'),
      tanner: w('Tanneur Corroyeur'), weaver: w('Tisserand Texier'), tailor: w('Tailleur Couturier'),
      baker: w('Boulanger Pestre'), miller: w('Meunier Moulin'), butcher: w('Boucher Lebouc'), cooper: w('Tonnelier Cuvelier'),
      cobbler: w('Cordier Cordonnier'), potter: w('Potier Poitevin'), fuller: w('Foulon Fouleur'), chandler: w('Chandelier Cirier'),
      wheelwright: w('Charron Rouelle'), saddler: w('Sellier Lormier'), fisher: w('Pecheur Peschier'),
      shepherd: w('Berger Pastor'), swineherd: w('Porcher'), farmer: w('Laboureur Paysan Vigneron'),
      labourer: w('Charretier Couvreur'), woodward: w('Forestier Boisier'), merchant: w('Marchand Mercier Drapier'),
      alewife: w('Brasseur Cervoisier'), priest: w('Clerc Lepretre'), servant: w('Valet Page'), soldier: w('Archer Sergent'),
      yeoman: w('Franc Franqueville'),
    },
    patronymic: 'none', patronymicShare: 0, locativeShare: 0.35, locative: 'de',
  },
  gael: {
    male: w(`Aodh Brian Cormac Donal Fergus Niall Murdoch Angus Duncan Malcolm Ruaidhri Sean Tadhg Conall Domhnall Eoghan
      Gilchrist Lachlan Somerled Cathal Diarmaid Fionn Ranald Kenneth Alasdair Callum Donnchad Finlay Ewan Neil
      Colm Eochaid Fearghal Gillespie Iain Lorcan Magnus Maol Muiredach Padraig Ruari Uilleam Ailean Baltair
      Dugald Gofraid Imar Kennan Murchad Oisin Tormod Cathbad`),
    female: w(`Siobhan Maire Aoife Brigid Grainne Una Eithne Fionnuala Gormlaith Mairead Sorcha Deirdre Moira Catriona
      Isbeil Effie Muirne Nuala Orla Sadb Mor Ailis Eilidh Beathag Aine Caoimhe Cait Derbhail Eibhlin Fainche
      Gobnait Iseabail Lasairfhiona Maeve Neasa Oonagh Peigi Rois Sine Treasa Mairi Ciara Brianag Gillian`),
    houses: w(`MacDonald MacLeod MacKenzie MacGregor Campbell Murray O'Neill O'Brien O'Connor MacCarthy Burke Sinclair
      Fraser Gordon MacDougall MacNeil MacLean Cameron Stewart Grant Menzies O'Donnell O'Rourke MacMahon
      Fitzgerald MacLachlan Maclaren O'Doherty Kennedy`),
    misc: w(`Ban Dubh Mor Beg Ruadh Fionn Garbh Cam Liath Donn Cael Og Gorm Bacach Fada Gearr Odhar Reagh Mac_Gille
      Dall Buidhe`),
    trades: {
      smith: w('Gow MacGowan Gowan'), carpenter: w('MacIntyre Wright'), mason: w('Mason MacMason'),
      tanner: w('Tanner Barker'), weaver: w('Webster Weaver'), tailor: w('Tailor Taylor'), baker: w('Baxter Baker'),
      miller: w('Millar Miller'), butcher: w('Butcher Fleshman'), cooper: w('Cooper Cowper'), cobbler: w('Souter Shoemaker'),
      potter: w('Potter'), fuller: w('Walker Waulker'), chandler: w('Chandler'), wheelwright: w('Wright Cartwright'),
      saddler: w('Sadler'), fisher: w('Fisher Fischer'), shepherd: w('Shepherd Hirdman'), swineherd: w('Swineherd'),
      farmer: w('Ploughman Farmer Grieve'), labourer: w('Carter Thatcher'), woodward: w('Forrester Woodman'),
      merchant: w('Merchant Chapman'), alewife: w('Brewster Brewer'), priest: w('Clerk MacTaggart'),
      servant: w('Page'), soldier: w('Archer Bowman'), yeoman: w('Freeman'),
    },
    patronymic: 'mac', patronymicShare: 0.5, locativeShare: 0.05, locative: 'of',
  },
  cymric: {
    male: w(`Rhys Owain Llywelyn Dafydd Hywel Madog Gruffudd Iorwerth Cadwgan Maredudd Bleddyn Einion Ieuan Morgan
      Trahaearn Cadell Gwilym Ithel Rhodri Tudur Elis Gwion Idwal Cynan Deiniol Alun Bran Caradog Cynfyn Dyfnwal
      Elidyr Gwallter Hoedlyw Iestyn Llewelyn Meurig Nest Padarn Rhirid Seisyll Taliesin Urien Wmffre Ynyr`),
    female: w(`Gwenllian Angharad Nest Gwladus Efa Gwenhwyfar Morfudd Tangwystl Marged Lowri Catrin Eleri Siwan Elen
      Ceinwen Dyddgu Gwen Mallt Generys Rhiannon Annest Cristin Haf Alis Bethan Cain Dwynwen Eurgain
      Gwerful Gwyneth Lleucu Mabli Nia Olwen Tegwen Wenlian Eirian Gweirydd Heledd Bronwen Cadi Ffion Glenys Myfanwy Nerys Tegan`),
    houses: w(`ap_Cadell ap_Bleddyn ap_Gruffudd ab_Owain ap_Rhys ap_Maredudd ap_Hywel ap_Tudur ap_Einion
      ap_Madog ap_Cynan ab_Iorwerth ap_Llywelyn ap_Rhodri ab_Ithel ap_Elidyr`),
    misc: w(`Goch Llwyd Fychan Gethin Gwyn Du Hir Bach Mawr Coch Lloyd Vaughan Gough Sais Wynn Pryce Prosser Bevan
      Powell Probert Parry`),
    trades: {
      smith: w('Gof Goch Smith'), carpenter: w('Saer Wright'), mason: w('Saer Mason'), tanner: w('Cenin Tanner'),
      weaver: w('Gwehydd Webb'), tailor: w('Teilwr Taylor'), baker: w('Pobydd Baker'), miller: w('Melinydd Miller'),
      butcher: w('Cigydd Butcher'), cooper: w('Cooper Cowper'), cobbler: w('Crydd Shoemaker'), potter: w('Crochenydd'),
      fuller: w('Pannwr Walker'), chandler: w('Chandler'), wheelwright: w('Wheeler'), saddler: w('Cyfrwywr'),
      fisher: w('Pysgotwr Fisher'), shepherd: w('Bugail Shepherd'), swineherd: w('Moch'), farmer: w('Ffermwr Gwas'),
      labourer: w('Gwas Carter'), woodward: w('Coedwr Forester'), merchant: w('Marsiandwr Merchant'),
      alewife: w('Bragwr Brewer'), priest: w('Offeiriad Clerk'), servant: w('Gwas Page'), soldier: w('Saethydd Archer'),
      yeoman: w('Gwyr Freeman'),
    },
    patronymic: 'ap', patronymicShare: 0.62, locativeShare: 0.04, locative: 'of',
  },
  norse: {
    male: w(`Erik Olaf Harald Sigurd Ragnar Bjorn Ivar Thorstein Gunnar Leif Magnus Halfdan Ulf Sven Knut Asbjorn
      Thorkel Orm Rolf Hakon Torvald Arne Eivind Ketil Skuli Steinar Vidar Geir Gudrod Hjalmar Ottar Rurik Aslak
      Bard Dag Finn Gisli Hallvard Ingvar Kolbein Lodin Njal Odd Rognvald Starkad Thorvald Tore Ulfar Vegard`),
    female: w(`Astrid Ingrid Sigrid Freya Gudrun Helga Thora Ragnhild Gunnhild Ingeborg Asa Bergljot Estrid Gyda Halla
      Ingibjorg Jorunn Katla Liv Margrethe Ranveig Signy Solveig Torunn Unn Yrsa Aslaug Bodil Dagny Eira Fridgerd
      Gunnvor Hallgerd Ingunn Jofrid Kristin Ljot Melkorka Njorun Oddny Rannveig Sunniva Thordis Valgerd`),
    houses: w(`Ragnarsson Haraldsson Sigurdsson Bjornsson Halfdansson Ivarsson Eriksson Olafsson Magnusson Knutsson
      Hakonsson Gudrodsson Rognvaldsson Thorfinnsson Ulfsson Skulesson`),
    misc: w(`Bonde Dahl Vik Strand Nes Haugen Bjerke Lund Berg Fjeld Sund Holm Rud Aas Moen Sand Eng Tveit Bakke
      Stenberg Hvit Svarte Rode Lang Kort`),
    trades: {
      smith: w('Smed Smidt'), carpenter: w('Timmerman Snekker'), mason: w('Murer Steinhogger'), tanner: w('Garver'),
      weaver: w('Vever'), tailor: w('Skredder'), baker: w('Baker Bakar'), miller: w('Moller Kvern'), butcher: w('Slakter'),
      cooper: w('Bodker'), cobbler: w('Skomaker'), potter: w('Pottemaker'), fuller: w('Valker'), chandler: w('Lysestoper'),
      wheelwright: w('Hjulmaker'), saddler: w('Salmaker'), fisher: w('Fiskar Fisker'), shepherd: w('Gjeter Sauehyrde'),
      swineherd: w('Svinegjeter'), farmer: w('Bonde Husmann'), labourer: w('Drengr Dreng'), woodward: w('Skogvokter'),
      merchant: w('Kjopmann Kaupmann'), alewife: w('Bryggar'), priest: w('Prest Klerk'), servant: w('Tjener Thrall'),
      soldier: w('Bogmann Huscarl'), yeoman: w('Odalsbonde'),
    },
    patronymic: 'sson', patronymicShare: 0.8, locativeShare: 0.1, locative: 'of',
  },
  teuton: {
    male: w(`Heinrich Konrad Dietrich Friedrich Gottfried Hartmann Ulrich Wolfram Werner Berthold Eberhard Siegfried
      Ludwig Otto Rudolf Hermann Albrecht Walther Gerhard Hans Peter Jakob Heinz Kunz Claus Burkhard Egilolf
      Giselher Lutz Rudiger Wernher Adalbert Baldur Dankwart Erhard Falk Gunther Hagen Ingo Kilian Lorenz
      Meinhard Notker Rainer Sigmund Tilman Volker Wigand Zeno`),
    female: w(`Adelheid Gertrud Kunigunde Mechthild Hedwig Irmgard Elisabeth Margarete Agnes Berta Greta Guta Hildegard
      Jutta Ottilie Richardis Sophie Uta Walburga Anna Katharina Else Grete Kunza Adelgund Brunhild Clara
      Dorothea Ermentrud Frieda Gisela Heilwig Imma Jolanthe Kriemhild Liutgard Mathilde Notburga Oda Reinhild
      Siglinde Trude Ursula Verena Wiltrud`),
    houses: w(`von_Hohenstaufen von_Habsburg von_Wittelsbach von_Zahringen von_Hessen von_Falkenstein
      von_Rosenberg von_Lindenau von_Eschenbach von_Tirol von_Henneberg von_Katzenelnbogen von_Nassau
      von_Wettin von_Querfurt von_Salm von_Leiningen von_Schwarzburg`),
    misc: w(`Klein Gross Lang Kurz Schwarz Weiss Braun Roth Jung Alt Hartmann Frei Stark Fuchs Wolf Vogel Bar Hahn
      Hase Adler Falke Hecht Kramer Neumann Ritter Konig`),
    trades: {
      smith: w('Schmidt Schmied Schmitt'), carpenter: w('Zimmermann Tischler'), mason: w('Maurer Steinmetz'),
      tanner: w('Gerber Lederer'), weaver: w('Weber Wever'), tailor: w('Schneider Schroder'), baker: w('Becker Backer Beck'),
      miller: w('Muller Mueller Moller'), butcher: w('Metzger Fleischer'), cooper: w('Bottcher Kufer'),
      cobbler: w('Schuster Schumacher'), potter: w('Topfer Hafner'), fuller: w('Walker Walcker'), chandler: w('Kerzer Lichtzieher'),
      wheelwright: w('Wagner Rademacher'), saddler: w('Sattler'), fisher: w('Fischer'), shepherd: w('Schafer Hirte'),
      swineherd: w('Sauhirt'), farmer: w('Bauer Meier'), labourer: w('Fuhrmann Dachdecker'), woodward: w('Forster Holzer'),
      merchant: w('Kaufmann Kramer Handler'), alewife: w('Brauer Wirth'), priest: w('Pfaff Schreiber'),
      servant: w('Knecht Magd'), soldier: w('Schutz Jager'), yeoman: w('Freimann Freyer'),
    },
    patronymic: 'none', patronymicShare: 0, locativeShare: 0.28, locative: 'von',
  },
};

function pickFrom(rng: Rng, list: readonly string[]): string { return list[Math.floor(rng.next() * list.length)]; }

export function firstName(rng: Rng, culture: CultureId, sex: Sex): string {
  const n = NAMES[culture];
  return pickFrom(rng, sex === 'm' ? n.male : n.female);
}

export function nobleHouseName(rng: Rng, culture: CultureId): string {
  return pickFrom(rng, NAMES[culture].houses);
}

/** Trade byname for a career (falls back to a miscellaneous byname). */
export function tradeByname(rng: Rng, culture: CultureId, career: CareerId): string {
  const n = NAMES[culture];
  const list = n.trades[career] ?? n.trades[career === 'cottar' ? 'labourer' : 'farmer'];
  return list && list.length ? pickFrom(rng, list) : pickFrom(rng, n.misc);
}

function vowelStart(s: string): boolean { return /^[AEIOUaeiou]/.test(s); }

/** Patronymic byname from the father's first name, by culture; '' where the culture has none. */
export function patronymic(culture: CultureId, sex: Sex, fatherFirst: string): string {
  switch (NAMES[culture].patronymic) {
    case 'son': return `${fatherFirst}son`;
    case 'sson': return `${fatherFirst}${sex === 'm' ? 'sson' : 'sdottir'}`;
    case 'ap': return `${sex === 'm' ? (vowelStart(fatherFirst) ? 'ab' : 'ap') : 'ferch'} ${fatherFirst}`;
    case 'mac': return `${sex === 'm' ? 'Mac' : 'Nic'}${fatherFirst}`;
    default: return '';
  }
}

export function locativeByname(culture: CultureId, place: string): string {
  return `${NAMES[culture].locative} ${place}`;
}

export interface NameContext {
  career?: CareerId;
  settlementName?: string;
  /** Nobles take the house name. */
  noble?: boolean;
  houseName?: string;
}

/** A byname for an adult with no known father (founders of lines, immigrants, servants). */
export function founderByname(rng: Rng, culture: CultureId, sex: Sex, ctx: NameContext = {}): string {
  if (ctx.noble) return ctx.houseName ?? nobleHouseName(rng, culture);
  const n = NAMES[culture];
  const r = rng.next();
  if (n.patronymic !== 'none' && r < n.patronymicShare) {
    return patronymic(culture, sex, firstName(rng, culture, 'm'));
  }
  if (ctx.settlementName && r > 1 - n.locativeShare) return locativeByname(culture, ctx.settlementName);
  if (ctx.career && r < 0.8) return tradeByname(rng, culture, ctx.career);
  return pickFrom(rng, n.misc);
}

/** A child's byname given the parents (surnames are hereditary through the father, patronymic
 *  cultures derive it from his first name). */
export function childByname(
  rng: Rng, culture: CultureId, sex: Sex,
  father: { first: string; byname: string } | null,
  mother: { first: string; byname: string } | null,
  /** The father belongs to a noble House: the house name is inherited unchanged. */
  dynastic = false,
): string {
  const n = NAMES[culture];
  if (father) {
    if (dynastic) return father.byname;
    if (n.patronymic === 'sson' || n.patronymic === 'ap') return patronymic(culture, sex, father.first);
    if (n.patronymic === 'mac' && rng.chance(0.5)) return patronymic(culture, sex, father.first);
    return father.byname;
  }
  if (mother) return mother.byname;
  return pickFrom(rng, n.misc);
}

/** Display name helper for any {first, byname}. */
export function displayName(p: { first: string; byname: string }): string {
  return p.byname ? `${p.first} ${p.byname}` : p.first;
}

/** First names of a culture (used by tests to validate generated names). */
export function firstNamesOf(culture: CultureId, sex: Sex): readonly string[] {
  return sex === 'm' ? NAMES[culture].male : NAMES[culture].female;
}
