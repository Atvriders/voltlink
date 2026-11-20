// cameraRig.ts — R2-43: the rig may drive the camera only until the user
// interacts. After the first orbit/zoom input, OrbitControls owns the camera
// and the rig must not lerp/snap it back every frame.
export function rigShouldFollow(userInteracted: boolean): boolean {
  return !userInteracted;
}
