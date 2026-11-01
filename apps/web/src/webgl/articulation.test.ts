import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPose, readExtras, wheelAngle } from './articulation';

function pivot(name: string, extras: Record<string, unknown>): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.userData = { voltlink: extras };
  return g;
}

describe('articulation.applyPose', () => {
  it('rotates a door pivot outward by openDeg * fraction', () => {
    const scene = new THREE.Group();
    const door = pivot('door_fl', { kind: 'rotate', axis: [0, 1, 0], openDeg: 60 });
    scene.add(door);
    const found = applyPose(scene, { door_fl: 0.5 });
    expect(found.has('door_fl')).toBe(true);
    const angle = door.quaternion.angleTo(new THREE.Quaternion());
    expect(Math.abs(angle - THREE.MathUtils.degToRad(30))).toBeLessThan(1e-4);
  });

  it('slides a window along its axis by distance * fraction', () => {
    const scene = new THREE.Group();
    const win = pivot('window_fl', { kind: 'slide', axis: [0, 0, -1], distance: 0.2 });
    scene.add(win);
    applyPose(scene, { window_fl: 1 });
    expect(Math.abs(win.position.z + 0.2)).toBeLessThan(1e-6);
  });

  it('hides hideAtOpen parts once open and shows them when closed', () => {
    const scene = new THREE.Group();
    const lid = pivot('frunk', { kind: 'rotate', axis: [0, 1, 0], openDeg: 58, hideAtOpen: true });
    scene.add(lid);
    applyPose(scene, { frunk: 0.01 });
    expect(lid.visible).toBe(false);
    applyPose(scene, { frunk: 0 });
    expect(lid.visible).toBe(true);
  });

  it('spins wheels continuously from roll distance', () => {
    const scene = new THREE.Group();
    const wheel = pivot('wheel_fl', { kind: 'spin', axis: [0, 1, 0] });
    scene.add(wheel);
    applyPose(scene, { wheel_fl: Math.PI / 2 });
    const angle = wheel.quaternion.angleTo(new THREE.Quaternion());
    expect(Math.abs(angle - Math.PI / 2)).toBeLessThan(1e-4);
  });

  it('ignores nodes without voltlink extras', () => {
    const scene = new THREE.Group();
    const plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    plain.name = 'body_mesh';
    scene.add(plain);
    expect(readExtras(plain)).toBeUndefined();
    expect(applyPose(scene, { body: 1 }).size).toBe(0);
  });

  it('computes wheel angle from roll distance', () => {
    expect(wheelAngle(Math.PI, 1)).toBeCloseTo(2 * Math.PI, 5);
    expect(wheelAngle(0, 0.7)).toBe(0);
  });
});
