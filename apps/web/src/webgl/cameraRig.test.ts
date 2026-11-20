// R2-43: the camera rig may drive the camera only until the user interacts —
// after the first orbit/zoom input the rig must never fight OrbitControls
// (the old rig lerped the camera every frame, so orbit/zoom snapped back).
import { describe, expect, it } from 'vitest';
import { rigShouldFollow } from './cameraRig';

describe('camera rig follow decision (R2-43)', () => {
  it('follows before the user interacts', () => {
    expect(rigShouldFollow(false)).toBe(true);
  });

  it('never follows after the first user interaction', () => {
    expect(rigShouldFollow(true)).toBe(false);
  });
});
