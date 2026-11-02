// scripts/assets/validate.ts — C-ASSETVALID. Loads GLBs with gltf-transform,
// computes with three's math classes, and fails the build on any violation.
// Usage: tsx scripts/assets/validate.ts [--staged dir] [--processed dir] [--check]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const specPath = path.join(root, 'blender', 'specs', 'vehicle_classes.json');
const SPEC = JSON.parse(readFileSync(specPath, 'utf8')) as {
  classes: Record<string, ClassSpec>;
};

interface DoorSpec {
  id: string;
  side: 'left' | 'right';
  z: [number, number];
  y: [number, number];
  hinge: 'front' | 'rear';
  openDeg: number;
}
interface ClassSpec {
  envelope: {
    length: number;
    width: number;
    height: number;
    wheelbase: number;
    frontOverhang: number;
    groundClearance: number;
    track: [number, number];
  };
  tire: { rimIn: number; widthMm: number; aspect: number };
  doors: DoorSpec[];
  rearClosure: {
    id: string;
    z: [number, number];
    y: [number, number];
    hinge: string;
    openDeg: number;
  };
  frunk: { z: [number, number]; openDeg: number };
  chargePort: { side: 'left' | 'right'; z: number; y: number; openDeg: number };
  budgets: { lod0: [number, number]; lod1: number; lod2: number; lod0Bytes: number };
}

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : dflt;
};
const STAGED = arg('--staged', path.join(root, 'assets', 'models'));
const PROCESSED = arg('--processed', path.join(root, 'assets', 'models', 'processed'));
const CHECK = argv.includes('--check');
const QUIET = argv.includes('--quiet');

const failures: string[] = [];
function fail(file: string, code: string, detail: string) {
  failures.push(`FAIL ${path.relative(root, file)} ${code} ${detail}`);
}

void MeshoptDecoder.ready; // ensure the decoder module is loaded
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

async function load(file: string) {
  return io.read(file);
}

function worldBox(
  doc: import('@gltf-transform/core').Document,
  node: import('@gltf-transform/core').Node,
): Box3 {
  const box = new Box3();
  const v = new Vector3();
  const m = new Matrix4();
  const visit = (n: import('@gltf-transform/core').Node, parentWorld: Matrix4) => {
    const local = new Matrix4().fromArray(n.getMatrix());
    const world = parentWorld.clone().multiply(local);
    for (const prim of n.getMesh()?.listPrimitives() ?? []) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        box.expandByPoint(v.fromArray(pos.getElement(i, [0, 0, 0])).applyMatrix4(world));
      }
    }
    for (const c of n.listChildren()) visit(c, world);
  };
  const parent = node.getParentNode();
  visit(node, parent ? m.fromArray(parent.getWorldMatrix()) : m.identity());
  return box;
}

function worldBoxOpened(
  doc: import('@gltf-transform/core').Document,
  node: import('@gltf-transform/core').Node,
  def: { axis: number[]; openDeg: number },
): Box3 {
  const box = new Box3();
  const v = new Vector3();
  const m = new Matrix4();
  const q = new Quaternion().setFromAxisAngle(
    new Vector3().fromArray(def.axis).normalize(),
    (def.openDeg * Math.PI) / 180,
  );
  const visit = (n: import('@gltf-transform/core').Node, parentWorld: Matrix4) => {
    let local: Matrix4;
    if (n === node) {
      local = new Matrix4()
        .fromArray(n.getMatrix())
        .multiply(new Matrix4().makeRotationFromQuaternion(q));
    } else {
      local = new Matrix4().fromArray(n.getMatrix());
    }
    const world = parentWorld.clone().multiply(local);
    for (const prim of n.getMesh()?.listPrimitives() ?? []) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        box.expandByPoint(v.fromArray(pos.getElement(i, [0, 0, 0])).applyMatrix4(world));
      }
    }
    for (const c of n.listChildren()) visit(c, world);
  };
  const parent = node.getParentNode();
  visit(node, parent ? m.fromArray(parent.getWorldMatrix()) : m.identity());
  return box;
}

function triangles(doc: import('@gltf-transform/core').Document): number {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const count = idx ? idx.getCount() : pos.getCount();
      tris += Math.floor(count / 3);
    }
  }
  return tris;
}

function collectNodes(doc: import('@gltf-transform/core').Document) {
  // listNodes() is already the flat graph — no recursion needed.
  const byName = new Map<string, import('@gltf-transform/core').Node>();
  for (const n of doc.getRoot().listNodes()) byName.set(n.getName(), n);
  return byName;
}

function extras(node: import('@gltf-transform/core').Node): {
  kind?: string;
  axis?: number[];
  openDeg?: number;
  distance?: number;
  state?: string;
  class?: string;
  lod?: number;
} | null {
  const e = node.getExtras() as { voltlink?: unknown } | null;
  if (!e || typeof e !== 'object') return null;
  const v = (e as { voltlink?: Record<string, unknown> }).voltlink;
  if (!v || typeof v !== 'object') return null;
  return v as {
    kind: string;
    axis?: number[];
    openDeg?: number;
    distance?: number;
    state?: string;
  };
}

function modelBounds(doc: import('@gltf-transform/core').Document, names?: string[]) {
  const nodes = collectNodes(doc);
  const box = new Box3();
  const list = names
    ? names.map((n) => nodes.get(n)).filter((n): n is import('@gltf-transform/core').Node => !!n)
    : doc.getRoot().listNodes();
  for (const node of list) box.union(worldBox(doc, node));
  return box;
}

// ---------------------------------------------------------------------------

const classes = Object.keys(SPEC.classes);
const classOf = (file: string) => classes.find((c) => file.startsWith(c)) ?? '';

for (const file of readdirSync(STAGED).filter((f) => f.endsWith('.glb') && !f.includes('.t'))) {
  const full = path.join(STAGED, file);
  const cls = classOf(file);
  if (!cls) {
    fail(full, 'SPEC_INVALID', 'no class spec for file');
    continue;
  }
  const spec = SPEC.classes[cls]!;
  const doc = await load(full);
  const nodes = collectNodes(doc);

  // SPEC_INVALID — glTF structure (staged files are uncompressed)
  const { default: validator } = await import('gltf-validator');
  const report = await validator.validateBytes(new Uint8Array(readFileSync(full)), {
    uri: file,
    externalResourceFunction: async () => ({ status: 404, error: {} }),
  });
  if (report.issues.numErrors > 0)
    fail(full, 'SPEC_INVALID', `gltf-validator: ${report.issues.numErrors} errors`);

  // BIN_EMPTY
  const buf = readFileSync(full);
  const binPresent = buf.length > 20 && buf.readUInt32LE(12) > 0;
  if (!binPresent) {
    fail(full, 'BIN_EMPTY', 'no BIN chunk');
  } else {
    for (const [name, node] of nodes) {
      if (!name.endsWith('_mesh')) continue;
      const mesh = node.getMesh();
      if (!mesh || mesh.listPrimitives().length === 0) {
        fail(full, 'BIN_EMPTY', `${name} has no primitives`);
        continue;
      }
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) {
          fail(full, 'BIN_EMPTY', `${name} has no POSITION`);
          continue;
        }
        const mn = pos.getMinNormalized([]) ?? [];
        const mx = pos.getMaxNormalized([]) ?? [];
        if (mn.some((n) => !Number.isFinite(n)) || mx.some((n) => !Number.isFinite(n))) {
          fail(full, 'BIN_EMPTY', `${name} POSITION min/max not finite`);
        }
      }
    }
  }

  // NAME_INVALID
  for (const name of nodes.keys()) {
    if (!/^[a-z0-9_]+$/.test(name) || name.includes('.'))
      fail(full, 'NAME_INVALID', `bad name: ${name}`);
  }

  // PART_MISSING — required part set per class
  const required = [
    'body_mesh',
    'trim_mesh',
    'underbody_mesh',
    'wheel_well_mesh',
    'windshield',
    'rear_glass',
    'window_fixed_l',
    'window_fixed_r',
    'mirror_l',
    'mirror_r',
    'wheel_fl',
    'wheel_fr',
    'wheel_rl',
    'wheel_rr',
    'tire_fl',
    'rim_fl',
    'brake_fl',
    'tire_fr',
    'rim_fr',
    'brake_fr',
    'tire_rl',
    'rim_rl',
    'brake_rl',
    'tire_rr',
    'rim_rr',
    'brake_rr',
    ...spec.doors.map((d) => d.id),
    ...spec.doors.map((d) => `${d.id}_mesh`),
    ...spec.doors.map((d) => `window_${d.id.slice(-2)}`),
    spec.rearClosure.id,
    `${spec.rearClosure.id}_mesh`,
    'frunk',
    'frunk_mesh',
    'charge_port',
    'charge_port_mesh',
    'charge_inlet',
    'charge_port_led',
    'charge_connector',
    'charge_connector_mesh',
    'charging_cable_mesh',
    'charge_dock',
    'headlight_l',
    'headlight_r',
    'taillight_l',
    'taillight_r',
    'brake_l',
    'brake_r',
    'dash',
    'seat_l',
    'seat_r',
    'seat_rear',
    'steering_wheel_mesh',
    'battery_mesh',
  ];
  for (const part of required) {
    if (!nodes.has(part)) fail(full, 'PART_MISSING', `missing ${part}`);
  }

  // PIVOT_TRANSFORM + PIVOT_POSITION + OPENS_INWARD per articulated node
  for (const [name, node] of nodes) {
    const ex = extras(node);
    if (!ex || !['hinge', 'slide', 'spin'].includes(ex.kind ?? '')) continue;
    if (node.getMesh()) fail(full, 'PIVOT_TRANSFORM', `${name} pivot carries a mesh`);
    const r = node.getRotation();
    const s = node.getScale();
    if (
      Math.abs(r[0]!) > 1e-6 ||
      Math.abs(r[1]!) > 1e-6 ||
      Math.abs(r[2]!) > 1e-6 ||
      Math.abs(r[3]! - 1) > 1e-6
    )
      fail(full, 'PIVOT_TRANSFORM', `${name} pivot rotated`);
    if (s.some((x) => Math.abs(x - 1) > 1e-6))
      fail(full, 'PIVOT_TRANSFORM', `${name} pivot not unit scale`);

    if (ex.kind === 'hinge' && ex.state) {
      let expected: [number, number, number] | null = null;
      if (ex.state.startsWith('door_')) {
        const d = spec.doors.find((dd) => dd.id === ex.state);
        if (d) {
          const x = (spec.envelope.width / 2 - 0.05) * (d.side === 'left' ? 1 : -1);
          expected = [x, d.y[1] - 0.02, d.hinge === 'front' ? d.z[1] : d.z[0]];
        }
      } else if (ex.state === 'rear_closure') {
        const rc = spec.rearClosure;
        if (rc.id === 'tailgate') {
          expected = [0, rc.y[0], (rc.z[0] + rc.z[1]) / 2];
        } else {
          expected = [0, rc.y[1], (rc.z[0] + rc.z[1]) / 2];
        }
      } else if (ex.state === 'frunk') {
        expected = [
          0,
          spec.envelope.groundClearance + spec.envelope.height * 0.42,
          spec.frunk.z[1],
        ];
      } else if (ex.state === 'charge_port') {
        const x = (spec.envelope.width / 2 - 0.03) * (spec.chargePort.side === 'left' ? 1 : -1);
        expected = [x, spec.chargePort.y, spec.chargePort.z + 0.05];
      }
      if (expected) {
        const pos = new Vector3().fromArray(node.getWorldTranslation());
        const dist = pos.distanceTo(new Vector3().fromArray(expected));
        if (dist > 0.01)
          fail(
            full,
            'PIVOT_POSITION',
            `${name} hinge ${dist.toFixed(3)} m from spec (${expected.map((n) => n.toFixed(2)).join(',')})`,
          );
        const partBox = worldBox(doc, node);
        const closed = new Vector3().fromArray(node.getWorldTranslation());
        if (partBox.distanceToPoint(closed) > 0.015)
          fail(
            full,
            'PIVOT_POSITION',
            `${name} pivot ${partBox.distanceToPoint(closed).toFixed(3)} m from its part bbox`,
          );
        // OPENS_INWARD
        if (ex.axis && typeof ex.openDeg === 'number') {
          const closedBox = worldBox(doc, node);
          const openBox = worldBoxOpened(doc, node, { axis: ex.axis, openDeg: ex.openDeg });
          if (file === 'compact_crossover.glb' && name === 'door_fl') {
            console.error(
              'DOORDBG closed',
              closedBox.min
                .toArray()
                .map((x) => x.toFixed(2))
                .join(','),
              closedBox.max
                .toArray()
                .map((x) => x.toFixed(2))
                .join(','),
            );
            console.error(
              'DOORDBG open  ',
              openBox.min
                .toArray()
                .map((x) => x.toFixed(2))
                .join(','),
              openBox.max
                .toArray()
                .map((x) => x.toFixed(2))
                .join(','),
            );
          }
          const st = ex.state;
          if (st.startsWith('door_')) {
            const d = spec.doors.find((dd) => dd.id === st)!;
            if (d.side === 'left') {
              if (!(openBox.max.x - closedBox.max.x >= 0.3))
                fail(full, 'OPENS_INWARD', `${name} does not open outward`);
              if (openBox.min.x < closedBox.min.x - 0.02)
                fail(full, 'OPENS_INWARD', `${name} swings inward`);
            } else {
              if (!(closedBox.min.x - openBox.min.x >= 0.3))
                fail(full, 'OPENS_INWARD', `${name} does not open outward`);
              if (openBox.max.x > closedBox.max.x + 0.02)
                fail(full, 'OPENS_INWARD', `${name} swings inward`);
            }
          } else if (st === 'rear_closure') {
            const kind = spec.rearClosure.id;
            if (kind === 'trunk') {
              if (openBox.max.y - closedBox.max.y < 0.25)
                fail(full, 'OPENS_INWARD', `${name} does not lift`);
            } else if (kind === 'liftgate') {
              if (openBox.min.y - closedBox.min.y < 0.4)
                fail(full, 'OPENS_INWARD', `${name} does not rise`);
              if (openBox.max.z > closedBox.max.z + 0.05)
                fail(full, 'OPENS_INWARD', `${name} swings forward`);
            } else if (kind === 'tailgate') {
              if (!(closedBox.min.z - openBox.min.z >= 0.3))
                fail(full, 'OPENS_INWARD', `${name} does not fold down`);
            }
          } else if (st === 'frunk') {
            if (openBox.max.y - closedBox.max.y < 0.25)
              fail(full, 'OPENS_INWARD', `${name} does not lift`);
          } else if (st === 'charge_port') {
            const outward =
              spec.chargePort.side === 'left'
                ? openBox.max.x - closedBox.max.x
                : closedBox.min.x - openBox.min.x;
            if (!(outward > 0.05 && outward < 0.3))
              fail(full, 'OPENS_INWARD', `${name} travel ${outward.toFixed(2)} m`);
          }
        }
      }
    }
  }

  // ENVELOPE — body shell only (mirrors legally protrude past the body)
  const b = modelBounds(doc, ['body_mesh', 'cab_mesh']);
  const dims = { length: b.max.z - b.min.z, width: b.max.x - b.min.x, height: b.max.y };
  for (const k of ['length', 'width', 'height'] as const) {
    const target = spec.envelope[k];
    const got = dims[k];
    if (Math.abs(got - target) / target > 0.02)
      fail(full, 'ENVELOPE', `${k} ${got.toFixed(3)} vs spec ${target} (±2%)`);
  }
  const wb = Math.abs(
    new Vector3().fromArray(nodes.get('wheel_fl')!.getWorldTranslation()).z -
      new Vector3().fromArray(nodes.get('wheel_rl')!.getWorldTranslation()).z,
  );
  if (Math.abs(wb - spec.envelope.wheelbase) / spec.envelope.wheelbase > 0.01)
    fail(full, 'ENVELOPE', `wheelbase ${wb.toFixed(3)} vs spec ${spec.envelope.wheelbase} (±1%)`);
  const under = nodes.get('underbody_mesh');
  if (under) {
    const ub = worldBox(doc, under);
    if (Math.abs(ub.min.y - spec.envelope.groundClearance) > 0.01)
      fail(
        full,
        'ENVELOPE',
        `ground clearance ${ub.min.y.toFixed(3)} vs spec ${spec.envelope.groundClearance} (±10mm)`,
      );
  }
  const tire = nodes.get('tire_fl');
  if (tire) {
    const tb = worldBox(doc, tire);
    const od = Math.max(tb.max.y - tb.min.y, tb.max.z - tb.min.z);
    const target =
      (spec.tire.rimIn * 25.4 + (2 * spec.tire.widthMm * spec.tire.aspect) / 100) / 1000;
    if (Math.abs(od - target) > 0.005)
      fail(full, 'ENVELOPE', `tire OD ${od.toFixed(3)} vs spec ${target.toFixed(3)} (±5mm)`);
  }

  // ANTI_PRIMITIVE (representative checks)
  // ASSETS-03: no body_mesh vertex may sit inside a tire cylinder +20 mm
  // (a wheel arch must exist). VERTEX test, not a bbox test.
  const bodyMesh = nodes.get('body_mesh');
  if (bodyMesh) {
    const wheelDefs: { c: Vector3; r: number; hw: number }[] = [];
    for (const w of ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']) {
      const piv = nodes.get(w);
      if (!piv) continue;
      wheelDefs.push({
        c: new Vector3().fromArray(piv.getWorldTranslation()),
        r:
          (spec.tire.rimIn * 25.4 + (2 * spec.tire.widthMm * spec.tire.aspect) / 100) / 1000 / 2 +
          0.02,
        hw: spec.tire.widthMm / 2000 + 0.02,
      });
    }
    const v = new Vector3();
    for (const prim of bodyMesh.getMesh()?.listPrimitives() ?? []) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const m = new Matrix4().fromArray(bodyMesh.getWorldMatrix());
      for (let i = 0; i < pos.getCount(); i++) {
        const p = v.fromArray(pos.getElement(i, [0, 0, 0])).applyMatrix4(m);
        for (const w of wheelDefs) {
          const dx = Math.abs(p.x - w.c.x);
          const dyz = Math.hypot(p.y - w.c.y, p.z - w.c.z);
          if (dx < w.hw && dyz < w.r) {
            fail(
              full,
              'ANTI_PRIMITIVE',
              `body_mesh vertex inside ${w.c.x.toFixed(2)} wheel cylinder`,
            );
            break;
          }
        }
      }
    }
  }
  const windshield = nodes.get('windshield');
  const windshieldEdgeZ = (which: 'top' | 'bottom'): number => {
    // mean z of the max/min-y vertices in world space
    const v = new Vector3();
    const m = new Matrix4();
    const ys: { y: number; z: number }[] = [];
    for (const prim of windshield?.getMesh()?.listPrimitives() ?? []) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const world = m.identity().multiply(new Matrix4().fromArray(windshield!.getWorldMatrix()));
      for (let i = 0; i < pos.getCount(); i++) {
        const p = v.fromArray(pos.getElement(i, [0, 0, 0])).applyMatrix4(world);
        ys.push({ y: p.y, z: p.z });
      }
    }
    if (ys.length === 0) return 0;
    const target =
      which === 'top' ? Math.max(...ys.map((p) => p.y)) : Math.min(...ys.map((p) => p.y));
    const sel = ys.filter((p) => Math.abs(p.y - target) < 0.02);
    return sel.reduce((a, p) => a + p.z, 0) / sel.length;
  };
  if (windshield) {
    const topZ = windshieldEdgeZ('top');
    const bottomZ = windshieldEdgeZ('bottom');
    if (!(topZ <= bottomZ - 0.3)) fail(full, 'ANTI_PRIMITIVE', 'windshield leans forward');
  }
  const dash = nodes.get('dash');
  if (dash && windshield) {
    const db = worldBox(doc, dash);
    if (db.max.z > windshieldEdgeZ('bottom') + 0.05)
      fail(full, 'ANTI_PRIMITIVE', 'dash in front of windshield base');
  }
  const rim = nodes.get('rim_fl');
  const tireN = nodes.get('tire_fl');
  if (rim && tireN) {
    const rb = worldBox(doc, rim);
    const tb2 = worldBox(doc, tireN);
    if (rb.max.x < tb2.max.x - 0.02) fail(full, 'ANTI_PRIMITIVE', 'rim hidden inside tire');
  }
  const frunk = nodes.get('frunk_mesh');
  if (frunk) {
    const fb = worldBox(doc, frunk);
    if (fb.max.y - fb.min.y >= 0.35 * (fb.max.z - fb.min.z))
      fail(full, 'ANTI_PRIMITIVE', 'frunk too tall');
  }

  // BUDGET (staged triangle counts + processed byte size)
  const tris = triangles(doc);
  const [lo, hi] = spec.budgets.lod0;
  const processedFile = path.join(PROCESSED, file);
  if (file.includes('_lod2')) {
    if (tris > spec.budgets.lod2) fail(full, 'BUDGET', `lod2 ${tris} tris > ${spec.budgets.lod2}`);
  } else if (file.includes('_lod')) {
    if (tris > spec.budgets.lod1) fail(full, 'BUDGET', `lod1 ${tris} tris > ${spec.budgets.lod1}`);
  } else {
    if (tris < lo || tris > hi) fail(full, 'BUDGET', `lod0 ${tris} tris outside [${lo}, ${hi}]`);
    if (existsSync(processedFile) && statSync(processedFile).size > spec.budgets.lod0Bytes) {
      fail(full, 'BUDGET', `processed ${file} exceeds ${spec.budgets.lod0Bytes} bytes`);
    }
  }
}

// LOD_MISMATCH — same node names and pivots across LODs
for (const cls of classes) {
  const names: string[][] = [];
  const pivots: Record<string, [number, number, number][]> = {};
  for (const lodSuffix of ['', '_lod', '_lod2']) {
    const f = path.join(STAGED, `${cls}${lodSuffix}.glb`);
    if (!existsSync(f)) continue;
    const doc = await load(f);
    const nodes = collectNodes(doc);
    names.push([...nodes.keys()].sort());
    for (const [name, node] of nodes) {
      if (extras(node))
        (pivots[name] ??= []).push(node.getWorldTranslation() as [number, number, number]);
    }
  }
  if (names.length === 3) {
    const base = names[0]!.join('|');
    for (const n of names)
      if (n.join('|') !== base) fail(`${cls}.glb`, 'LOD_MISMATCH', 'node set differs across LODs');
    for (const [name, positions] of Object.entries(pivots)) {
      if (positions.length < 3) continue;
      for (const p of positions) {
        if (new Vector3().fromArray(p).distanceTo(new Vector3().fromArray(positions[0]!)) > 0.001) {
          fail(`${cls}.glb`, 'LOD_MISMATCH', `pivot ${name} moved across LODs`);
          break;
        }
      }
    }
  }
}

// DISTINCT — classes must be visibly distinct, not one resized model
const wheelbases = classes.map((c) => SPEC.classes[c]!.envelope.wheelbase);
for (let i = 0; i < wheelbases.length; i++) {
  for (let j = i + 1; j < wheelbases.length; j++) {
    if (Math.abs(wheelbases[i]! - wheelbases[j]!) < 0.015)
      fail('spec', 'DISTINCT', `wheelbases ${classes[i]}/${classes[j]} within 15mm`);
  }
}
const closureTypes = new Set(classes.map((c) => SPEC.classes[c]!.rearClosure.id));
if (closureTypes.size < 3) fail('spec', 'DISTINCT', `only ${closureTypes.size} rear-closure types`);
const ports = classes.map(
  (c) => `${SPEC.classes[c]!.chargePort.z.toFixed(2)},${SPEC.classes[c]!.chargePort.y.toFixed(2)}`,
);
if (new Set(ports).size !== ports.length)
  fail('spec', 'DISTINCT', 'charge-port positions not distinct');

// MANIFEST_DRIFT
const manifestPath = path.join(root, 'apps', 'web', 'public', '3d', 'manifest.json');
if (CHECK && existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    files: Record<string, { bytes: number }>;
  };
  for (const [name, meta] of Object.entries(manifest.files ?? {})) {
    const f = path.join(root, 'apps', 'web', 'public', '3d', name);
    if (!existsSync(f)) {
      fail(manifestPath, 'MANIFEST_DRIFT', `missing ${name}`);
      continue;
    }
    if (statSync(f).size !== meta.bytes)
      fail(manifestPath, 'MANIFEST_DRIFT', `${name} bytes changed`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
if (!QUIET) console.log(`✓ asset validation passed (${classes.length} classes, staged=${STAGED})`);
