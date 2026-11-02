// articulation.ts — pure vehicle pose application from node extras (guide 06 §10).
// No React or rendering dependencies: apply a pose (0..1 open fractions) to a
// glTF scene by walking nodes and reading their {"voltlink":{...}} extras.
import * as THREE from 'three';

export type ArticulationKind = 'rotate' | 'slide' | 'translate' | 'spin';

export interface ArticulationExtras {
  kind: ArticulationKind;
  /** Rotation axis in glTF space (x left, y up, z front). */
  axis?: [number, number, number];
  /** Full-open rotation in degrees (positive rotates outward per convention). */
  openDeg?: number;
  /** Full-open travel distance in meters. */
  distance?: number;
  /** Hide the mesh once the part starts to open. */
  hideAtOpen?: boolean;
}

export interface VehiclePose {
  /** Door/window/frunk/trunk/liftgate/tailgate/charge_port open fractions, 0..1. */
  [part: string]: number | undefined;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const _v = new THREE.Vector3();

/** Read the articulation extras off a node (the pivot EMPTY carries them). */
export function readExtras(node: THREE.Object3D): ArticulationExtras | undefined {
  const extras = (node.userData?.voltlink ?? node.userData?.extras?.voltlink) as
    ArticulationExtras | undefined;
  return extras?.kind ? extras : undefined;
}

/**
 * Apply a pose to the scene in place. Resets every articulated node to its
 * closed/zero state first, then applies fractions for the parts present in
 * the pose. Returns the set of part names actually found in the scene.
 */
export function applyPose(root: THREE.Object3D, pose: VehiclePose): Set<string> {
  const found = new Set<string>();
  const nodes: THREE.Object3D[] = [root];
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    const extras = readExtras(node);
    if (extras) {
      const name = node.name;
      found.add(name);
      const fraction = clamp01(Number(pose[name]) || 0);

      switch (extras.kind) {
        case 'rotate': {
          const deg = extras.openDeg ?? 0;
          if (extras.axis) {
            _v.fromArray(extras.axis);
            node.quaternion.setFromAxisAngle(_v, THREE.MathUtils.degToRad(deg * fraction));
          }
          break;
        }
        case 'slide':
        case 'translate': {
          const distance = extras.distance ?? 0;
          if (extras.axis) {
            _v.fromArray(extras.axis).multiplyScalar(distance * fraction);
            node.position.copy(_v);
          }
          break;
        }
        case 'spin': {
          // Continuous rotation; the pose value is an angle in radians, not 0..1.
          const angle = Number(pose[name]) || 0;
          if (extras.axis) {
            _v.fromArray(extras.axis);
            node.quaternion.setFromAxisAngle(_v, angle);
          }
          break;
        }
      }
      if (extras.hideAtOpen && fraction > 0) node.visible = false;
      else node.visible = true;
    }
    for (const child of node.children) nodes.push(child);
  }
  return found;
}

/** Compute a target angle (radians) for a wheel spin given roll distance. */
export function wheelAngle(rollMeters: number, tireDiameterMeters: number): number {
  return (rollMeters / (Math.PI * Math.max(0.01, tireDiameterMeters))) * Math.PI * 2;
}
