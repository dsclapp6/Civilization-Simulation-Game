// The DOM UI (wave 2): main menu, run start, HUD and every panel. Entry point for the app.
import { createUiApp } from './app/ui';
import type { CreateUI, GameUIExt } from './types';
import './style/theme.css';
import './style/hud.css';
import './style/screens.css';
import './style/panels.css';
import './style/clarity.css';

export const createUI: CreateUI = (root, host): GameUIExt => createUiApp(root, host);

export type { GameUIExt } from './types';
