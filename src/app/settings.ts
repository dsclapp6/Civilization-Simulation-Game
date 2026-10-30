// Settings persistence: `Settings` (ui/types.ts) live in `profile.settings`, next to the Legacy gold, so
// they survive runs and reloads. Reading is forgiving: anything missing, of the wrong type or out of range
// falls back to the default; keys this build does not know are left alone in the profile.
import type { Profile } from '../sim/legacy';
import { DEFAULT_SETTINGS, type QualitySetting, type Settings } from '../ui/types';

const QUALITIES: readonly QualitySetting[] = ['low', 'medium', 'high'];

const RANGES: Record<string, readonly [number, number]> = { mouseSensitivity: [0.1, 4], volume: [0, 1], uiScale: [0.8, 1.4] };

/** The settings stored in a profile, validated and completed with defaults. */
export function readSettings(profile: Profile): Settings {
  const raw = profile.settings ?? {};
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = raw[key];
    if (typeof v !== typeof def) continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      const r = RANGES[key];
      out[key] = r ? Math.min(r[1], Math.max(r[0], v)) : v;
    } else out[key] = v;
  }
  if (!(QUALITIES as readonly string[]).includes(out.quality as string)) out.quality = DEFAULT_SETTINGS.quality;
  return out as unknown as Settings;
}

/** Writes the settings into the profile (the caller saves the profile). */
export function writeSettings(profile: Profile, settings: Settings): void {
  profile.settings = { ...profile.settings, ...settings };
}

/** The quality named by a `?quality=` URL parameter, if valid. */
export function qualityParam(value: string | null): QualitySetting | null {
  return value && (QUALITIES as readonly string[]).includes(value) ? (value as QualitySetting) : null;
}
