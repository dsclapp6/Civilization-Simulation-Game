// Wave 3 module panels register themselves here: one import line per module file, e.g.
//   import './military';   (src/ui/panels/military.ts calls registerPanel('army', …))
// Each wave 3 builder adds only its own line.
import './politics';
import './combat';
import './advancement';
import './military';
// civilization pass, wave B: builder mode (B) and the ruler's seat of government (U)
import '../builder/builder';
import '../ruler/ruler';
export {};
