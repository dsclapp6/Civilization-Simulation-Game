// Family-tree layout (pure): lays a descendant tree out in rows by generation, centring each
// parent (and their spouse, drawn beside them) over their children. Output is plain rectangles and
// connector segments the panel draws as cards and an SVG overlay.
import type { FamilyNode } from '../../sim/api';

export const CARD_W = 150;
export const CARD_H = 58;
export const SPOUSE_GAP = 22;
export const SIBLING_GAP = 18;
export const ROW_GAP = 46;
export const MARGIN = 20;

export interface PlacedCard {
  id: number;
  x: number;
  y: number;
  /** 'main' = a descendant in the tree; 'spouse' = married in. */
  role: 'main' | 'spouse';
  node: FamilyNode;
  /** For spouses: the descendant they are wed to. */
  partner?: number;
}

export interface Segment { x1: number; y1: number; x2: number; y2: number; kind: 'line' | 'marriage' }

export interface FamilyLayout {
  cards: PlacedCard[];
  segments: Segment[];
  width: number;
  height: number;
  byId: Map<number, PlacedCard>;
}

interface Measured { node: FamilyNode; hasSpouse: boolean; width: number; unit: number; kids: Measured[] }

function measure(node: FamilyNode, hasSpouseOf: (n: FamilyNode) => boolean): Measured {
  const hasSpouse = hasSpouseOf(node);
  const unit = hasSpouse ? CARD_W * 2 + SPOUSE_GAP : CARD_W;
  const kids = node.children.map((c) => measure(c, hasSpouseOf));
  const kidsWidth = kids.reduce((n, k) => n + k.width, 0) + Math.max(0, kids.length - 1) * SIBLING_GAP;
  return { node, hasSpouse, unit, kids, width: Math.max(unit, kidsWidth) };
}

/**
 * `spouseNode(n)` supplies the spouse's card data (a stub FamilyNode) or null when the person is
 * unmarried / the spouse is unknown.
 */
export function layoutFamily(root: FamilyNode, spouseNode: (n: FamilyNode) => FamilyNode | null): FamilyLayout {
  const m = measure(root, (n) => spouseNode(n) !== null);
  const cards: PlacedCard[] = [];
  const segments: Segment[] = [];
  const byId = new Map<number, PlacedCard>();
  let maxDepth = 0;

  const place = (mm: Measured, left: number, depth: number): { anchorX: number } => {
    maxDepth = Math.max(maxDepth, depth);
    const y = MARGIN + depth * (CARD_H + ROW_GAP);
    const kidsWidth = mm.kids.reduce((n, k) => n + k.width, 0) + Math.max(0, mm.kids.length - 1) * SIBLING_GAP;
    // children first (they decide where the parents centre)
    let cx = left + (mm.width - kidsWidth) / 2;
    const anchors: number[] = [];
    for (const k of mm.kids) {
      const kidLeft = cx;
      const placed = place(k, kidLeft, depth + 1);
      anchors.push(placed.anchorX);
      cx += k.width + SIBLING_GAP;
    }
    const centre = mm.kids.length ? (anchors[0] + anchors[anchors.length - 1]) / 2 : left + mm.width / 2;
    const unitLeft = centre - mm.unit / 2;
    const main: PlacedCard = { id: mm.node.id, x: unitLeft, y, role: 'main', node: mm.node };
    cards.push(main);
    byId.set(main.id, main);
    let anchorX = unitLeft + CARD_W / 2;
    if (mm.hasSpouse) {
      const sp = spouseNode(mm.node);
      if (sp) {
        const spCard: PlacedCard = { id: sp.id, x: unitLeft + CARD_W + SPOUSE_GAP, y, role: 'spouse', node: sp, partner: mm.node.id };
        cards.push(spCard);
        if (!byId.has(sp.id)) byId.set(sp.id, spCard);
        segments.push({ x1: unitLeft + CARD_W, y1: y + CARD_H / 2, x2: spCard.x, y2: y + CARD_H / 2, kind: 'marriage' });
        anchorX = unitLeft + CARD_W + SPOUSE_GAP / 2;
      }
    }
    // connectors to the children: a drop from the couple, a bar, then drops to each child
    if (mm.kids.length) {
      const barY = y + CARD_H + ROW_GAP / 2;
      segments.push({ x1: anchorX, y1: mm.hasSpouse ? y + CARD_H / 2 : y + CARD_H, x2: anchorX, y2: barY, kind: 'line' });
      if (anchors.length > 1 || Math.abs(anchors[0] - anchorX) > 0.5) {
        segments.push({ x1: Math.min(anchorX, ...anchors), y1: barY, x2: Math.max(anchorX, ...anchors), y2: barY, kind: 'line' });
      }
      for (const a of anchors) segments.push({ x1: a, y1: barY, x2: a, y2: y + CARD_H + ROW_GAP, kind: 'line' });
    }
    return { anchorX };
  };

  place(m, MARGIN, 0);
  return {
    cards, segments, byId,
    width: m.width + MARGIN * 2,
    height: MARGIN * 2 + (maxDepth + 1) * CARD_H + maxDepth * ROW_GAP,
  };
}

/** Number of people drawn (descendants plus spouses), for tests and sizing. */
export function countCards(layout: FamilyLayout): number { return layout.cards.length; }
