// First person (the default view): the camera sits at the player's eyes and the player's own head is left out of the camera's view (it still
// casts its shadow, see assets/characters/engine/crowd.ts). Per frame this finds the eyes in the character layer (the rider's eyes on a horse),
// hands them to the camera rig, and tells the layer whose head to hide. The body, arms, hands and what they hold stay in view: look down and
// they are yours, and at rest the arms are posed low in front of you (assets/characters/human/animator.ts fpArms).
import * as THREE from 'three';
import type { PlayerView } from '../core/view';
import type { CameraRig } from './camera/cameraRig';

/** What the character layer offers for it (see assets/characters/layer.ts); the stand-in asset layers have neither. */
export interface EyeLayer {
  setFirstPerson?(id: number): void;
  eyePos?(id: number, out: THREE.Vector3): boolean;
}

export class FirstPerson {
  private readonly v = new THREE.Vector3();
  private hidden = -1;
  /** Eye height above the feet kept for the frames in which the layer cannot say (just built, culled). */
  private off = 1.6;

  /** Call before `rig.update`. `streetView`: false on the map or in a building (no eyes then). */
  update(rig: CameraRig, layer: EyeLayer, pl: PlayerView | null, streetView: boolean): void {
    if (!pl || !pl.alive || !streetView || !layer.eyePos) { this.release(layer); rig.clearEye(); return; }
    if (layer.eyePos(pl.personId, this.v)) this.off = this.v.y - pl.y;
    const y = pl.y + (this.off > 0.3 && this.off < 3 ? this.off : 1.6);
    // the body is where the eyes are: x and z are the body's (steady), the height is the animation's (sitting, riding)
    rig.setEye(pl.x, y, pl.z, pl.mounted ? 0 : 1);
    const want = rig.inFirstPerson ? pl.personId : -1;
    if (want !== this.hidden) { layer.setFirstPerson?.(want); this.hidden = want; }
  }

  private release(layer: EyeLayer): void {
    if (this.hidden !== -1) { layer.setFirstPerson?.(-1); this.hidden = -1; }
  }
}
