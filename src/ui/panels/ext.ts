// Wave 3 module panels register themselves here: one import line per module file, e.g.
//   import './military';   (src/ui/panels/military.ts calls registerPanel('army', …))
// Each wave 3 builder adds only its own line.
import './politics';
import './combat';
import './advancement';
import './military';
// civilization pass, wave B: the battle's command HUD (group bar, banners, order wheel; registered through src/ui/core/extHud.ts)
// and the tactical view (the ext panel 'battle'), which imports it
import './battle';
export {};
