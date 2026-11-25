// R2-43: the camera rig may drive the camera only until the user interacts —
// after the first orbit/zoom input the rig must never fight OrbitControls
// (the old rig lerped the camera every frame, so orbit/zoom snapped back).
import { describe, expect, it } from 'vitest';
import { RIG_LOOK_AT, rigShouldFollow } from './cameraRig';

describe('camera rig follow decision (R2-43)', () => {
  it('follows before the user interacts', () => {
    expect(rigShouldFollow(false)).toBe(true);
  });

  it('never follows after the first user interaction', () => {
    expect(rigShouldFollow(true)).toBe(false);
  });

  it('the rig and OrbitControls share one look-at point (no first-orbit jump)', () => {
    // OrbitControls gets target={RIG_LOOK_AT}; the rig eases the camera to
    // the same point, so the first orbit never snaps the view.
    expect(RIG_LOOK_AT).toEqual([0, 0.7, 0]);
  });
});
