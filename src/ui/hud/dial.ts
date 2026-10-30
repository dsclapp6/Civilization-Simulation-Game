// The sun/moon dial: a little clock face where noon is at the top. The gold wedge is the day's
// daylight (it widens in summer), the indigo rest is night; a sun or moon rides the rim.
import type { Season } from '../../core/time';
import { svgEl, staticSvg } from '../core/dom';
import { dialModel } from '../core/hudModel';

const R = 21;

function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
}

export class Dial {
  readonly el: SVGElement;
  private readonly wedge: SVGElement;
  private readonly hand: SVGElement;
  private readonly sunG: SVGElement;
  private readonly moonG: SVGElement;
  private season: Season | -1 = -1;
  private lastHand = NaN;
  private lastNight: boolean | null = null;

  constructor(size = 50) {
    this.el = svgEl('svg', { viewBox: '-25 -25 50 50', width: String(size), height: String(size), class: 'mu-dial', 'aria-hidden': 'true' });
    const base = staticSvg(`
      <defs>
        <radialGradient id="mu-dial-night" cx=".5" cy=".7" r=".8"><stop offset="0" stop-color="#2c3566"/><stop offset="1" stop-color="#0f1330"/></radialGradient>
        <radialGradient id="mu-dial-day" cx=".5" cy=".25" r=".9"><stop offset="0" stop-color="#fff0b0"/><stop offset="1" stop-color="#e1b13f"/></radialGradient>
      </defs>
      <circle r="${R + 2.2}" fill="#20140a"/>
      <circle r="${R}" fill="url(#mu-dial-night)"/>`);
    while (base.firstChild) this.el.appendChild(base.firstChild);
    this.wedge = svgEl('path', { fill: 'url(#mu-dial-day)' });
    this.el.appendChild(this.wedge);
    const ticks = staticSvg(`
      <circle r="${R}" fill="none" stroke="url(#mu-gold)" stroke-width="2.2"/>
      <circle r="${R - 7.5}" fill="none" stroke="rgba(30,18,6,.35)" stroke-width=".7"/>
      <path d="M0 ${-R + 1.2}v3.2M0 ${R - 1.2}v-3.2M${-R + 1.2} 0h3.2M${R - 1.2} 0h-3.2" stroke="rgba(30,18,6,.55)" stroke-width="1.1" stroke-linecap="round"/>`);
    while (ticks.firstChild) this.el.appendChild(ticks.firstChild);
    this.sunG = svgEl('g', { class: 'sun' });
    const sun = staticSvg(`<circle r="4.6" fill="#fff6c8" stroke="#a8760f" stroke-width="1.2"/><circle r="2" fill="#f4c542"/>`);
    while (sun.firstChild) this.sunG.appendChild(sun.firstChild);
    this.moonG = svgEl('g', { class: 'moon' });
    const moon = staticSvg(`<circle r="4.4" fill="#e9eefc" stroke="#3b4672" stroke-width="1.1"/><circle cx="1.9" cy="-1" r="3.6" fill="#1b2147"/>`);
    while (moon.firstChild) this.moonG.appendChild(moon.firstChild);
    this.hand = svgEl('g');
    this.hand.appendChild(this.sunG);
    this.hand.appendChild(this.moonG);
    this.el.appendChild(this.hand);
  }

  /** Cheap to call every frame: only touches the DOM when the hand moves a visible amount. */
  set(season: Season, dayFraction: number): void {
    const m = dialModel(season, dayFraction);
    if (season !== this.season) {
      this.season = season;
      const [x1, y1] = polar(m.sunriseDeg, R);
      const [x2, y2] = polar(m.sunsetDeg, R);
      this.wedge.setAttribute('d', `M0 0L${x1.toFixed(2)} ${y1.toFixed(2)}A${R} ${R} 0 1 1 ${x2.toFixed(2)} ${y2.toFixed(2)}Z`);
    }
    const rounded = Math.round(m.handDeg * 2) / 2;
    if (rounded !== this.lastHand) {
      this.lastHand = rounded;
      const [hx, hy] = polar(rounded, R - 11.2);
      this.hand.setAttribute('transform', `translate(${hx.toFixed(2)} ${hy.toFixed(2)})`);
    }
    if (m.night !== this.lastNight) {
      this.lastNight = m.night;
      this.sunG.setAttribute('display', m.night ? 'none' : 'inline');
      this.moonG.setAttribute('display', m.night ? 'inline' : 'none');
    }
  }
}
