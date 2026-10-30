// Inline SVG icon set (24×24, stroke-based, `currentColor`). Drawn by hand so the UI needs no image
// files. `F` marks a filled shape. Keep glyphs simple: they are read at 14–22 px.
import { staticSvg } from './dom';

const F = ' fill="currentColor" stroke="none"';

const ICONS = {
  // --- vitals and needs
  heart: `<path d="M12 20.4C5.2 15.6 3 11.8 3 8.8A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 9 1.8c0 3-2.2 6.8-9 11.6z"${F}/>`,
  heart_o: `<path d="M12 20.4C5.2 15.6 3 11.8 3 8.8A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 9 1.8c0 3-2.2 6.8-9 11.6z"/>`,
  bolt: `<path d="M13.4 2.6 5.6 13.4h5.2l-1 8 8.6-11.4h-5.4z"${F}/>`,
  coin: `<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="5.4"/><path d="M12 9.2v5.6M10.2 11h3.6"/>`,
  bread: `<path d="M3.8 14.2c0-4 3.6-7.2 8.2-7.2s8.2 3.2 8.2 7.2c0 1.7-1 3-2.6 3H6.4c-1.6 0-2.6-1.3-2.6-3z"/><path d="M8.8 10.6l1.6 2.6M12.6 9.9l1.6 2.8M16 11.2l.9 1.9"/>`,
  moon_z: `<path d="M19.6 15.4A8 8 0 0 1 8.6 4.4a8 8 0 1 0 11 11z"/><path d="M15 3.6h4l-4 4.4h4"/>`,
  flame: `<path d="M12 21.2c-4.1 0-6.8-2.8-6.8-6.4 0-3.2 2.1-5 3.6-6.9.7-.9 1-2.1.8-3.7 3.2 1.1 6.2 4.2 6.6 7.4.8-.6 1.3-1.5 1.4-2.6 1.3 1.6 1.9 3.3 1.9 5 0 3.8-3.4 7.2-7.5 7.2z"/><path d="M12 18.4c-1.6 0-2.7-1.1-2.7-2.6 0-1.5 1.2-2.3 2-3.4.6 1.2 3.4 2.2 3.4 4.2 0 1.1-1 1.8-2.7 1.8z"/>`,
  face: `<circle cx="12" cy="12" r="8.6"/><circle cx="9" cy="10.4" r=".9"${F}/><circle cx="15" cy="10.4" r=".9"${F}/><path d="M8.2 14.4c1 1.7 2.4 2.5 3.8 2.5s2.8-.8 3.8-2.5"/>`,
  frown: `<circle cx="12" cy="12" r="8.6"/><circle cx="9" cy="10.4" r=".9"${F}/><circle cx="15" cy="10.4" r=".9"${F}/><path d="M8.4 16.2c1-1.5 2.3-2.2 3.6-2.2s2.6.7 3.6 2.2"/>`,
  sun: `<circle cx="12" cy="12" r="4.2"${F}/><path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>`,
  moon: `<path d="M19.6 15.4A8.2 8.2 0 0 1 8.6 4.4a8.2 8.2 0 1 0 11 11z"${F}/>`,
  // --- speed
  pause: `<rect x="6.2" y="5" width="4" height="14" rx="1"${F}/><rect x="13.8" y="5" width="4" height="14" rx="1"${F}/>`,
  play: `<path d="M7.5 4.6v14.8L19 12z"${F}/>`,
  play2: `<path d="M3.5 5.2v13.6L12 12zM12.2 5.2v13.6L20.7 12z"${F}/>`,
  play3: `<path d="M2.2 6.2v11.6L9 12zM8.6 6.2v11.6L15.4 12zM15 6.2v11.6L21.8 12z"${F}/>`,
  hourglass: `<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4.6 4 5.6 4.5 8.5-.5 2.9-4.5 3.9-4.5 8.5M16.5 3.5c0 4.6-4 5.6-4.5 8.5.5 2.9 4.5 3.9 4.5 8.5"/>`,
  swords: `<path d="M4.5 4.5l10.5 10.5M19.5 4.5L9 15"/><path d="M13 17.5l3.5-3.5M11 17.5L7.5 14M15.6 19.4l2-2M8.4 19.4l-2-2"/>`,
  skull: `<path d="M12 3.4c-4.2 0-7 2.7-7 6.4 0 2.3 1 3.7 2.5 4.6V18h9v-3.6c1.5-.9 2.5-2.3 2.5-4.6 0-3.7-2.8-6.4-7-6.4z"/><circle cx="9.3" cy="10.8" r="1.4"${F}/><circle cx="14.7" cy="10.8" r="1.4"${F}/><path d="M10.6 18v2.4M13.4 18v2.4M12 13.6v1.6"/>`,
  shield: `<path d="M12 3l7.5 2.6v5.7c0 4.4-3 8-7.5 9.7-4.5-1.7-7.5-5.3-7.5-9.7V5.6z"/>`,
  crown: `<path d="M4 18.6h16M4.6 17 3.6 8l4.9 4L12 5.6 15.5 12l4.9-4-1 9z"/>`,
  quill: `<path d="M20 4c-8 0-13 5-14.2 12.6L4.4 20M20 4c.2 7-4.6 11.6-11.6 11.4M9 14.6c3-1 6.2-4 8-8"/>`,
  lock: `<rect x="5.5" y="10.5" width="13" height="9.6" rx="1.6"/><path d="M8.6 10.5V8a3.4 3.4 0 0 1 6.8 0v2.5"/>`,
  check: `<path d="M5 12.6l4.4 4.4L19 7.4"/>`,
  cross: `<path d="M6 6l12 12M18 6L6 18"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  minus: `<path d="M5 12h14"/>`,
  arrow_up: `<path d="M12 19V6M6.4 11.2 12 5.6l5.6 5.6"/>`,
  arrow_down: `<path d="M12 5v13M6.4 12.8 12 18.4l5.6-5.6"/>`,
  chev_left: `<path d="M14.6 5.4 8 12l6.6 6.6"/>`,
  chev_right: `<path d="M9.4 5.4 16 12l-6.6 6.6"/>`,
  chev_down: `<path d="M5.4 9.4 12 16l6.6-6.6"/>`,
  chev_up: `<path d="M5.4 14.6 12 8l6.6 6.6"/>`,
  tri_up: `<path d="M12 6.5 19 17H5z"${F}/>`,
  tri_down: `<path d="M12 17.5 5 7h14z"${F}/>`,
  search: `<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.2 5.2"/>`,
  info: `<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4"/><circle cx="12" cy="7.8" r=".8"${F}/>`,
  question: `<circle cx="12" cy="12" r="8.6"/><path d="M9.4 9.6a2.7 2.7 0 1 1 4 2.3c-1 .6-1.4 1.2-1.4 2.3"/><circle cx="12" cy="16.9" r=".8"${F}/>`,
  warning: `<path d="M12 3.6 21 19.4H3z"/><path d="M12 10v4.4"/><circle cx="12" cy="16.8" r=".8"${F}/>`,
  star: `<path d="M12 3.4l2.6 5.6 6 .7-4.5 4.1 1.3 6L12 16.9 6.6 19.8l1.3-6L3.4 9.7l6-.7z"/>`,
  star_f: `<path d="M12 3.4l2.6 5.6 6 .7-4.5 4.1 1.3 6L12 16.9 6.6 19.8l1.3-6L3.4 9.7l6-.7z"${F}/>`,
  sparkle: `<path d="M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1z"/>`,
  dot: `<circle cx="12" cy="12" r="3.4"${F}/>`,
  home: `<path d="M4 12l8-7 8 7M6.4 10.4V19h11.2v-8.6M10.4 19v-4.6h3.2V19"/>`,
  calendar: `<rect x="4" y="5.5" width="16" height="14.5" rx="1.6"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>`,
  save: `<path d="M5 3.6h11l3 3V20H5z"/><path d="M8 3.6v5h7v-5M8 20v-6h8v6"/>`,
  door: `<path d="M9 4.4H5.4v15.2H9M14 7.6l4.4 4.4-4.4 4.4M18.4 12H9.4"/>`,
  // --- navigation / panels
  user: `<circle cx="12" cy="8" r="4"/><path d="M4.6 20.4c.8-4.2 4-6.4 7.4-6.4s6.6 2.2 7.4 6.4"/>`,
  users: `<circle cx="9" cy="8.4" r="3.1"/><circle cx="17" cy="9.6" r="2.5"/><path d="M3.4 19.4c.5-3.5 3-5.6 5.6-5.6s5.1 2.1 5.6 5.6M15.4 14.2c2.6-.4 4.8 1.2 5.4 4.6"/>`,
  bag: `<path d="M5.6 8.6h12.8l1 11.4H4.6z"/><path d="M9 8.6V7a3 3 0 0 1 6 0v1.6"/>`,
  tree: `<circle cx="12" cy="5.2" r="2.4"/><circle cx="6" cy="18.8" r="2.4"/><circle cx="18" cy="18.8" r="2.4"/><path d="M12 7.6V12M6 16.4V12h12v4.4"/>`,
  book: `<path d="M12 6.2C10 4.8 7 4.2 4 4.6V18c3-.4 6 .2 8 1.6 2-1.4 5-2 8-1.6V4.6c-3-.4-6 .2-8 1.6zM12 6.2v13.4"/>`,
  map: `<path d="M3.5 6.4l5.5-2 6 2 5.5-2v13.2l-5.5 2-6-2-5.5 2z"/><path d="M9 4.4v13.2M15 6.4v13.2"/>`,
  scroll: `<path d="M6.5 5h11.5v13H6.5z"/><path d="M6.5 5C4.4 5 4.4 8.4 6.5 8.4M18 18c2.1 0 2.1-3.4 0-3.4"/><path d="M9.5 10h6M9.5 13h6"/>`,
  bed: `<path d="M3.6 18.6V8.4M3.6 15h16.8v3.6M20.4 15v-3.2a3 3 0 0 0-3-3H11V15"/><circle cx="7.2" cy="11.7" r="1.8"/>`,
  cog: `<circle cx="12" cy="12" r="3.1"/><path d="M12 3l1.5 2.3 2.6-.6.8 2.5 2.5.8-.6 2.6L21 12l-2.2 1.5.6 2.6-2.5.8-.8 2.5-2.6-.6L12 21l-1.5-2.3-2.6.6-.8-2.5-2.5-.8.6-2.6L3 12l2.2-1.5-.6-2.6 2.5-.8.8-2.5 2.6.6z"/>`,
  keycap: `<rect x="3.5" y="4" width="17" height="16" rx="3"/>`,
  // --- stats
  str: `<path d="M7.4 11.4V8.2a1.5 1.5 0 0 1 3 0v-.6a1.5 1.5 0 0 1 3 0v.6a1.5 1.5 0 0 1 3 0v3.2l.6 3.2c.4 3.2-1.8 5.8-4.8 5.8h-1.2c-2.6 0-4.2-2-4.2-4.6z"/><path d="M7.4 11.4l-1.9-1.2"/>`,
  end: `<path d="M12 20.4C5.2 15.6 3 11.8 3 8.8A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 9 1.8c0 3-2.2 6.8-9 11.6z"/><path d="M5.4 12.4h3.6l1.6-3 2.4 6 1.6-3h4"/>`,
  agi: `<path d="M5 19.2c4.6-1 8.8-5.2 11.4-12.8 1.2 4.4-.6 9.4-5.2 12.2-2 1.2-4.4 1.2-6.2.6z"/><path d="M6.2 18c3-3 6-6 9-9.2"/>`,
  int: `<path d="M9.4 21h5.2M10.2 21V11.4h3.6V21M12 11.4V9.6"/><path d="M12 2.8c1.8 2 2.3 3.4 2.3 4.5a2.3 2.3 0 0 1-4.6 0c0-1.1.5-2.5 2.3-4.5z"/>`,
  per: `<path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12z"/><circle cx="12" cy="12" r="3"/>`,
  cha: `<path d="M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1z"/>`,
  // --- skills
  farming: `<path d="M12 21.2V8"/><path d="M12 8c-2.6 0-3.6-2-3.6-4.2 2.4 0 3.6 1.7 3.6 4.2zM12 8c2.6 0 3.6-2 3.6-4.2-2.4 0-3.6 1.7-3.6 4.2zM12 13c-2.6 0-3.9-2-3.9-4.2 2.5 0 3.9 1.7 3.9 4.2zM12 13c2.6 0 3.9-2 3.9-4.2-2.5 0-3.9 1.7-3.9 4.2zM12 18c-2.6 0-3.9-2-3.9-4.2 2.5 0 3.9 1.7 3.9 4.2zM12 18c2.6 0 3.9-2 3.9-4.2-2.5 0-3.9 1.7-3.9 4.2z"/>`,
  husbandry: `<path d="M9 21.2V9.2a4 4 0 1 1 8 0c0 1.7-1 2.8-2.6 3.2"/>`,
  hunting: `<path d="M6 3.6c9.4 3 9.4 13.8 0 16.8M6 3.6v16.8"/><path d="M9.6 12H21M18 9l3 3-3 3"/>`,
  woodcutting: `<path d="M5.6 20.6 15.4 8"/><path d="M13.4 5.2c3.2-1.6 6.4-.4 7.6 2.2-3 .2-5.4 1.4-7 3.4z"/>`,
  mining: `<path d="M4.4 19.6 15 9"/><path d="M5.4 8.6Q13 2.4 19.8 10.4"/>`,
  smithing: `<path d="M3.6 8.8h13.8c0 2.6-2 3.6-4 4V15h2v3.4H8.4V15h2v-2.2c-3.4-.4-5.4-1.4-6.8-4zM17.4 8.8h3.4l-1 2.2h-2.6"/>`,
  carpentry: `<path d="M3.6 15 16.4 5.6l3.8 6.2L8 20.6z"/><path d="M6.6 16.2l1.2 1.8M9 14.4l1.2 1.8M11.4 12.6l1.2 1.8"/>`,
  masonry: `<rect x="3.6" y="5" width="16.8" height="14" rx="1"/><path d="M3.6 9.7h16.8M3.6 14.3h16.8M9.4 5v4.7M15 9.7v4.6M8 14.3V19"/>`,
  tailoring: `<path d="M7 4h10M7 20h10M8.6 4v16M15.4 4v16M8.6 8h6.8M8.6 12h6.8M8.6 16h6.8"/>`,
  brewing: `<path d="M5.6 9h9.8v11H5.6z"/><path d="M15.4 10.6h2a2 2 0 0 1 2 2v2.4a2 2 0 0 1-2 2h-2"/><path d="M6.4 9c-.2-2.2 1.6-3.2 3.2-2.4 1-1.6 3.6-1.2 4 .8 1 0 1.8.8 1.8 1.6"/>`,
  trade: `<path d="M12 4.4v15.6M7 20h10M5 7.6h14"/><path d="M5 7.6 2.6 13.4a3 3 0 0 0 5.6 0zM19 7.6l-2.6 5.8a3 3 0 0 0 5.6 0z"/>`,
  stewardship: `<circle cx="7.6" cy="12" r="3.6"/><path d="M11.2 12H21M18.4 12v3.4M15.4 12v2.6"/>`,
  leadership: `<path d="M6 21V3.6"/><path d="M6 4.6h13.2l-3 4.6 3 4.6H6"/>`,
  persuasion: `<path d="M4.4 5.4h15.2v10.2h-8l-4.4 4v-4H4.4z"/><path d="M8.4 9h7.2M8.4 12h4.6"/>`,
  melee: `<path d="M20 4 9.4 14.6"/><path d="M20 4h-4.2M20 4v4.2"/><path d="M6.8 13.4l3.8 3.8"/><path d="M8.6 15.4 4.6 19.4"/><circle cx="3.9" cy="20.1" r="1"${F}/>`,
  archery: `<circle cx="11.6" cy="12.4" r="8.2"/><circle cx="11.6" cy="12.4" r="4.4"/><circle cx="11.6" cy="12.4" r="1.1"${F}/><path d="M12 12 20.6 3.4M16.8 3.4h3.8V7.2"/>`,
  riding: `<path d="M6.2 20.4c-1-5.8-1-8 .8-11A6 6 0 0 1 17.4 9c1.8 3 1.8 5.2.8 11.4h-3.2c.6-4 .8-5.8-.5-7.8a3.5 3.5 0 0 0-5.1 0c-1.3 2-1.1 3.8-.5 7.8z"/>`,
  medicine: `<path d="M5 19.2C5 11 10 4.8 20 4.8c0 9.2-5 15.4-12.6 14.4"/><path d="M5 19.2c3-4.2 6-7.2 9.2-9.6"/>`,
  letters: `<path d="M20 4c-8 0-13 5-14.2 12.6L4.4 20M20 4c.2 7-4.6 11.6-11.6 11.4M9 14.6c3-1 6.2-4 8-8"/>`,
  stealth: `<path d="M12 3.4c-4.5 0-7.5 3.6-7.5 8.2 0 3 1.5 5 3.5 6.4V21h8v-3c2-1.4 3.5-3.4 3.5-6.4 0-4.6-3-8.2-7.5-8.2z"/><path d="M8.6 12.2h2.6M12.8 12.2h2.6"/>`,
  // --- action categories / generic verbs
  hammer: `<path d="M14 4.4l5.6 5.6-3 3-5.6-5.6z"/><path d="M12.4 11.4 4.8 19"/>`,
  talk: `<path d="M4.4 5.4h15.2v10.2h-8l-4.4 4v-4H4.4z"/>`,
  hand: `<path d="M8.2 12.4V5.8a1.4 1.4 0 0 1 2.8 0v5M11 11V4.6a1.4 1.4 0 0 1 2.8 0V11M13.8 11V5.6a1.4 1.4 0 0 1 2.8 0v6.6M16.6 12.2V9.6a1.4 1.4 0 0 1 2.8 0v4.6c0 4-2.5 6.8-6.8 6.8H11c-2.4 0-3.8-1.4-5-3.4L4.4 14c-.5-1.2.7-2.2 1.8-1.5l2 1.5"/>`,
  signpost: `<path d="M12 3v18M12 5.6h6.4l2 2.2-2 2.2H12M12 11.8H5.6l-2 2.2 2 2.2H12"/>`,
  ledger: `<path d="M5.4 3.6h13.2v16.8H5.4z"/><path d="M8.6 3.6v16.8M11.6 8h4.4M11.6 11.4h4.4M11.6 14.8h3"/>`,
  key: `<circle cx="7.6" cy="12" r="3.6"/><path d="M11.2 12H21M18.4 12v3.4M15.4 12v2.6"/>`,
  gift: `<rect x="4" y="9" width="16" height="11" rx="1"/><path d="M4 13h16M12 9v11M12 9c-3.4-4.4-6.6-1.4-4 0M12 9c3.4-4.4 6.6-1.4 4 0"/>`,
  purse: `<path d="M8.4 8.4h7.2l3.4 5v6H5v-6z"/><path d="M8.8 8.4 7.8 5h8.4l-1 3.4"/>`,
  ring: `<circle cx="12" cy="14.6" r="5.4"/><path d="M9.6 6.8 12 3.6l2.4 3.2-2.4 1.8z"/>`,
  dagger: `<path d="M19.6 4.4 9.6 14.4"/><path d="M19.6 4.4l-4 .8-1 3.6z"/><path d="M7.6 12.6l3.8 3.8M9.6 14.4 5.4 18.6"/>`,
  boot: `<path d="M8 3.6h6v8.2l5.4 2.6V19H5.4V13c0-1.6 1.2-2 2.6-2.6z"/>`,
  // --- goods and equipment
  wheat: `<path d="M12 21.2V8"/><path d="M12 8c-2.6 0-3.6-2-3.6-4.2 2.4 0 3.6 1.7 3.6 4.2zM12 8c2.6 0 3.6-2 3.6-4.2-2.4 0-3.6 1.7-3.6 4.2zM12 13c-2.6 0-3.9-2-3.9-4.2 2.5 0 3.9 1.7 3.9 4.2zM12 13c2.6 0 3.9-2 3.9-4.2-2.5 0-3.9 1.7-3.9 4.2z"/>`,
  cup: `<path d="M5.6 9h9.8v11H5.6z"/><path d="M15.4 10.6h2a2 2 0 0 1 2 2v2.4a2 2 0 0 1-2 2h-2"/><path d="M6.4 9c-.2-2.2 1.6-3.2 3.2-2.4 1-1.6 3.6-1.2 4 .8 1 0 1.8.8 1.8 1.6"/>`,
  apple: `<path d="M12 8.4C8 5.8 4 8.4 4 13.4c0 4.4 3 7.8 5 7.8 1.2 0 2-.6 3-.6s1.8.6 3 .6c2 0 5-3.4 5-7.8 0-5-4-7.6-8-5z"/><path d="M12 8.4c0-2 .8-3.6 2.6-4.6"/>`,
  log: `<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1"${F}/>`,
  ingot: `<path d="M3.6 17.6l3-8h10.8l3 8z"/><path d="M6.6 9.6l2-3h6.8l2 3"/>`,
  helm: `<path d="M5 19.4v-7.2a7 7 0 0 1 14 0v7.2z"/><path d="M5 13.2h14M12 13.2v6.2"/>`,
  tunic: `<path d="M8.6 4 3.6 7l2 4 2-1v10.4h8.8V10l2 1 2-4-5-3c-.5 1.5-1.7 2.3-3.5 2.3S9.1 5.5 8.6 4z"/>`,
  sheep: `<ellipse cx="11.4" cy="12.4" rx="7" ry="5"/><circle cx="19" cy="11.8" r="2.2"/><path d="M8 17.4V20M14.6 17.4V20"/>`,
  box: `<path d="M4 8l8-4 8 4v9l-8 4-8-4zM4 8l8 4 8-4M12 12v9"/>`,
  armour: `<path d="M7.2 4.4 3.6 7.2l1.8 4 2-.8v9.8h9.2v-9.8l2 .8 1.8-4-3.6-2.8c-.8 1.6-2.4 2.4-4.4 2.4S8 6 7.2 4.4z"/><path d="M7.4 13.2h9.2M7.4 16.2h9.2"/>`,
  quiver: `<path d="M9.4 21 7 11.6 12.4 3.4l2.2 1.4L10.6 12l3.4 9z"/><path d="M14 3.4l3-1M15.2 5.6l3-.8"/>`,
  horse: `<path d="M6.2 20.4c-1-5.8-1-8 .8-11A6 6 0 0 1 17.4 9c1.8 3 1.8 5.2.8 11.4h-3.2c.6-4 .8-5.8-.5-7.8a3.5 3.5 0 0 0-5.1 0c-1.3 2-1.1 3.8-.5 7.8z"/>`,
  // --- settlements
  hut: `<path d="M4 12l8-7 8 7M6.4 10.4V19h11.2v-8.6"/>`,
  village: `<path d="M2.6 13l5-4.6 5 4.6M4 12v6.6h7.2V12M11 11l5.6-5 5.4 5M13 10.4v8.2h7.2v-8.2"/>`,
  walls: `<path d="M3 20V9.4h3v2h2.2v-2h3v2h2.2v-2h3v2H20v-2h1V20z"/><path d="M10.4 20v-4.4h3.2V20"/>`,
  towers: `<path d="M3.6 20V8h3.2V5.2h3V8h4.4V5.2h3V8h3.2v12z"/><path d="M10.2 20v-5.4h3.6V20M6.4 11.6h.1M17.5 11.6h.1"/>`,
  castle: `<path d="M5 20.4V7l2-.8V4h2v2h2V4h2v2h2V4h2v2.2l2 .8v13.4z"/><path d="M10.4 20.4v-5.2h3.2v5.2"/>`,
  church: `<path d="M12 2.6v5M9.8 5h4.4"/><path d="M6.4 20.4v-8.2L12 8l5.6 4.2v8.2zM10.4 20.4v-4.8h3.2v4.8"/>`,
  cross_holy: `<path d="M12 3v18M7 8h10"/>`,
  market: `<path d="M3.6 10l1.6-5h13.6l1.6 5c0 1.6-1.2 2.6-2.7 2.6S14.8 11.6 14.8 10c0 1.6-1.2 2.6-2.8 2.6S9.2 11.6 9.2 10c0 1.6-1.2 2.6-2.8 2.6S3.6 11.6 3.6 10zM5.6 12.8V20h12.8v-7.2"/>`,
  pin: `<path d="M12 21s6.4-5.8 6.4-11a6.4 6.4 0 0 0-12.8 0c0 5.2 6.4 11 6.4 11z"/><circle cx="12" cy="10" r="2.2"/>`,
  trend_up: `<path d="M4 16l5-5 3.4 3.4L20 7M15 7h5v5"/>`,
  trend_down: `<path d="M4 8l5 5 3.4-3.4L20 17M15 17h5v-5"/>`,
  refresh: `<path d="M19.4 12a7.4 7.4 0 1 1-2.2-5.2M19.6 4.6v4.4h-4.4"/>`,
  grip: `<circle cx="9" cy="7" r="1.2"${F}/><circle cx="15" cy="7" r="1.2"${F}/><circle cx="9" cy="12" r="1.2"${F}/><circle cx="15" cy="12" r="1.2"${F}/><circle cx="9" cy="17" r="1.2"${F}/><circle cx="15" cy="17" r="1.2"${F}/>`,
  hatchet: `<path d="M5.6 20.6 15.4 8"/><path d="M13.4 5.2c3.2-1.6 6.4-.4 7.6 2.2-3 .2-5.4 1.4-7 3.4z"/>`,
  bell: `<path d="M6 17.4c1.2-1.4 1.6-3 1.6-5.4a4.4 4.4 0 0 1 8.8 0c0 2.4.4 4 1.6 5.4zM10 20.2h4"/>`,
  drop: `<path d="M12 3.4c3.4 4.2 5.6 7 5.6 10.2a5.6 5.6 0 0 1-11.2 0c0-3.2 2.2-6 5.6-10.2z"/>`,
  flag: `<path d="M6 21V4M6 5h11l-2.4 3.6L17 12H6"/>`,
  target: `<circle cx="12" cy="12" r="7.6"/><circle cx="12" cy="12" r="2.4"/><path d="M12 2.4v4M12 17.6v4M2.4 12h4M17.6 12h4"/>`,
  help: `<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.8 2.4c-.8.5-1.2 1-1.2 2M12 17v.2"/>`,
  eye_off: `<path d="M3 3l18 18M10.4 6c.5-.1 1-.2 1.6-.2 6 0 9.6 6.2 9.6 6.2s-1.2 2.2-3.4 4M6.6 7.8C3.9 9.4 2.4 12 2.4 12s3.6 6.4 9.6 6.4c1.4 0 2.6-.3 3.7-.8"/>`,
} as const;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

const templates = new Map<IconName, SVGElement>();

function template(name: IconName): SVGElement {
  let t = templates.get(name);
  if (!t) {
    const holder = staticSvg(ICONS[name]);
    t = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const part of SVG_ATTRS.match(/[\w-]+="[^"]*"/g) ?? []) {
      const eq = part.indexOf('=');
      t.setAttribute(part.slice(0, eq), part.slice(eq + 2, -1));
    }
    t.setAttribute('aria-hidden', 'true');
    while (holder.firstChild) t.appendChild(holder.firstChild);
    templates.set(name, t);
  }
  return t;
}

/** An inline SVG icon sized in px (the stylesheet may override with the `.mu-ico` class). Parsed once, then cloned. */
export function icon(name: IconName, size = 18, cls = ''): SVGElement {
  const svg = template(name).cloneNode(true) as SVGElement;
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `mu-ico${cls ? ` ${cls}` : ''}`);
  return svg;
}

/** Markup of an icon, for embedding in other static SVG. */
export function iconMarkup(name: IconName): string { return ICONS[name]; }
