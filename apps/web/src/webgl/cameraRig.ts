// cameraRig.ts — R2-43: the rig may drive the camera only until the user
// interacts. After the first orbit/zoom input, OrbitControls owns the camera
// and the rig must not lerp/snap it back every frame.
export function rigShouldFollow(userInteracted: boolean): boolean {
  return !userInteracted;
}

/** The look-at point the rig eases the camera toward. OrbitControls uses the
 * SAME point as its target, so the first orbit never jumps (R2-43: the old
 * controls defaulted to (0,0,0) while the rig aimed at (0,0.7,0)). */
export const RIG_LOOK_AT: [number, number, number] = [0, 0.7, 0];
