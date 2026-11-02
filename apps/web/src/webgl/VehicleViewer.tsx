// State-aware WebGL vehicle viewer (React Three Fiber).
//
// - Loads the original Blender-generated GLB for the vehicle class from
//   /assets/models/<class>.glb with a named-part convention:
//   body, wheels, headlights, taillights, door_fl, door_fr, door_rl, door_rr,
//   trunk, frunk, charge_port, charge_connector, interior, windows, mirrors.
// - If the GLB is missing, renders a clearly labeled procedural fallback
//   silhouette (graceful degradation, never a blank screen).
// - Animates lock/unlock, doors, trunk, frunk, charge port, charging pulse,
//   lights, security alerts, and offline/sleep states.
// - Graphics presets (low/medium/high/ultra), context-loss recovery, GPU
//   cleanup, reduced-motion support.

import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleState, VehicleWithState } from '@voltlink/shared';
import { resolveAssetUrl } from './vehicleAssets';

import { PRESETS, autoPreset, type GraphicsPreset } from './preset';
export { PRESETS, autoPreset };
export type { GraphicsPreset };

// Class-specific camera framing (spec L1269/L1626) and day/night lighting.
const CLASS_CAMERA: Record<string, [number, number, number]> = {
  compact_sedan: [5.0, 2.4, 5.8],
  sport_sedan: [5.4, 2.2, 6.2],
  compact_crossover: [5.6, 2.8, 6.6],
  suv: [6.0, 3.0, 7.0],
  pickup: [6.4, 2.8, 7.6],
  fallback: [5.2, 2.6, 6.2],
};

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const classCamera = (cls: string): [number, number, number] =>
  (CLASS_CAMERA[cls] ?? CLASS_CAMERA.fallback) as [number, number, number];

/** Smoothly eases the default camera toward the class framing (spec L1300). */
function CameraRig({ target }: { target: [number, number, number] }) {
  const targetRef = useRef(new THREE.Vector3(...target));
  useEffect(() => {
    targetRef.current.set(...target);
  }, [target]);
  useFrame((state) => {
    const cam = state.camera;
    const t = targetRef.current;
    if (reducedMotion()) {
      cam.position.copy(t);
      cam.lookAt(0, 0.7, 0);
      return;
    }
    cam.position.lerp(t, 0.05);
    cam.lookAt(0, 0.7, 0);
  });
  return null;
}

function findPart(obj: THREE.Object3D, name: string): THREE.Object3D | null {
  if (obj.name === name || obj.name.toLowerCase().endsWith(name.toLowerCase())) return obj;
  for (const child of obj.children) {
    const found = findPart(child, name);
    if (found) return found;
  }
  return null;
}

function VehicleModel({
  url,
  vehicle,
  state,
  preset,
  signal,
  onLoaded,
}: {
  url: string;
  vehicle: VehicleWithState;
  state: VehicleState | null;
  preset: GraphicsPreset;
  signal: { ok: boolean };
  onLoaded?: () => void;
}) {
  const gltf = useLoader(GLTFLoader, url);
  const ref = useRef<THREE.Group>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const parts = useMemo(() => {
    const scene = gltf.scene.clone();
    // Spec L1301: apply the vehicle's real paint color to the body mesh.
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && /body|trim/.test(o.name)) {
        const mesh = o as THREE.Mesh;
        const mat = (mesh.material as THREE.Material).clone();
        if ('color' in mat && vehicle.exteriorColor) {
          (mat as THREE.MeshStandardMaterial).color.set(vehicle.exteriorColor);
          (mat as THREE.MeshStandardMaterial).metalness = 0.35;
          (mat as THREE.MeshStandardMaterial).roughness = 0.5;
        }
        mesh.material = mat;
      }
    });
    const map: Record<string, THREE.Object3D> = {};
    for (const p of [
      'door_fl',
      'door_fr',
      'door_rl',
      'door_rr',
      'trunk',
      'frunk',
      'charge_port',
      'charge_connector',
      'headlights',
      'taillights',
      'interior',
    ]) {
      const found = findPart(scene, p);
      if (found) map[p] = found;
    }
    // soft-shadow-friendly materials
    if (preset === 'high' || preset === 'ultra') {
      scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
          if (m && m.roughness !== undefined && m.roughness > 0.9) {
            (o as THREE.Mesh).castShadow = false;
            (o as THREE.Mesh).receiveShadow = true;
          } else {
            (o as THREE.Mesh).castShadow = true;
            (o as THREE.Mesh).receiveShadow = false;
          }
        }
      });
    }
    return { scene, map };
  }, [gltf, preset, vehicle.exteriorColor]);

  useEffect(() => {
    signal.ok = true;
    onLoaded?.();
    return () => {
      signal.ok = false;
      // Spec L1316/L1679: dispose every cloned geometry and material on unmount.
      parts.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) m?.dispose();
        }
      });
    };
  }, [signal, onLoaded, parts.scene]);

  useFrame(({ clock }) => {
    const s = stateRef.current;
    if (!s) return;
    const t = clock.elapsedTime;
    const { map } = parts;

    // Doors (rotate about their hinge-side — approximate with Y rotation).
    for (const [name, open] of [
      ['door_fl', s.doors?.frontLeft],
      ['door_fr', s.doors?.frontRight],
      ['door_rl', s.doors?.rearLeft],
      ['door_rr', s.doors?.rearRight],
    ] as const) {
      const part = map[name];
      if (part && !part.userData.baseRot) part.userData.baseRot = part.rotation.y;
      if (part) {
        const target =
          (part.userData.baseRot ?? 0) + (open ? (name.includes('r') ? -0.65 : 0.65) : 0);
        part.rotation.y = THREE.MathUtils.damp(part.rotation.y, target, 6, 1 / 60);
      }
    }
    const trunk = map.trunk;
    if (trunk) {
      if (!trunk.userData.baseRotX) trunk.userData.baseRotX = trunk.rotation.x;
      trunk.rotation.x = THREE.MathUtils.damp(
        trunk.rotation.x,
        (trunk.userData.baseRotX ?? 0) + (s.trunkOpen ? -0.85 : 0),
        6,
        1 / 60,
      );
    }
    const frunk = map.frunk;
    if (frunk) {
      if (!frunk.userData.baseRotX) frunk.userData.baseRotX = frunk.rotation.x;
      frunk.rotation.x = THREE.MathUtils.damp(
        frunk.rotation.x,
        (frunk.userData.baseRotX ?? 0) + (s.frunkOpen ? 0.8 : 0),
        6,
        1 / 60,
      );
    }
    const port = map.charge_port;
    if (port) {
      if (!port.userData.baseRotY) port.userData.baseRotY = port.rotation.y;
      port.rotation.y = THREE.MathUtils.damp(
        port.rotation.y,
        (port.userData.baseRotY ?? 0) + (s.chargePortOpen ? 0.7 : 0),
        6,
        1 / 60,
      );
    }
    // Headlights
    if (map.headlights) {
      const on = !!(s.climateOn || s.status === 'driving' || s.flashLightsBlink);
      map.headlights.visible = s.flashLightsBlink ? Math.sin(t * 14) > 0 : on;
    }
    if (map.taillights) {
      const brake = (s.speedKmh ?? 0) < 1 && s.status === 'online';
      map.taillights.visible = s.flashLightsBlink ? Math.sin(t * 14) > 0 : brake || !!s.climateOn;
    }
    // Charging pulse on connector
    const conn = map.charge_connector;
    if (conn) {
      conn.visible = s.plugConnected || s.chargingState === 'charging';
      if (s.chargingState === 'charging') {
        const m = conn as THREE.Mesh;
        const mat = m.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
        const mats = Array.isArray(mat) ? mat : [mat];
        const intensity = 0.5 + Math.sin(t * 3) * 0.5;
        for (const mm of mats) mm.emissive = new THREE.Color('#22d3ee').multiplyScalar(intensity);
      }
    }
    // Security alert flash (red hazard pulse).
    const scene = ref.current;
    if (scene && s.alarmState === 'triggered') {
      const body = findPart(scene, 'body');
      if (body && (body as THREE.Mesh).isMesh) {
        const m = (body as THREE.Mesh).material as THREE.MeshStandardMaterial;
        m.emissive = new THREE.Color('#ff4444').multiplyScalar(Math.sin(t * 8) > 0 ? 0.25 : 0.05);
      }
    }
    // Offline: dim the whole vehicle slightly.
    if (scene) {
      const target = s.status === 'offline' ? 0.55 : 1;
      scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
          const base = mat.userData.baseOpacity ?? 1;
          mat.userData.baseOpacity = base;
          mat.transparent = target < 1;
          mat.opacity = THREE.MathUtils.damp(mat.opacity, target, 4, 1 / 60);
        }
      });
    }
  });

  return <primitive ref={ref} object={parts.scene} />;
}

function FallbackVehicle({
  vehicle,
  state,
}: {
  vehicle: VehicleWithState;
  state: VehicleState | null;
}) {
  // Original procedural fallback silhouette (used only when the GLB is missing).
  const group = useRef<THREE.Group>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const s = stateRef.current;
    g.rotation.y = clock.elapsedTime * 0.12;
    const body = g.children[0] as THREE.Mesh | undefined;
    if (body && (body.material as THREE.MeshStandardMaterial).emissive) {
      const charging = s?.chargingState === 'charging';
      (body.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(
        '#22d3ee',
      ).multiplyScalar(charging ? 0.35 + Math.sin(clock.elapsedTime * 4) * 0.2 : 0.08);
    }
  });
  const color = vehicle.exteriorColor ?? '#8b9bb4';
  return (
    <group ref={group}>
      <mesh castShadow position={[0, 0.62, 0]}>
        <boxGeometry args={[1.9, 0.7, 4.1]} />
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.5} />
      </mesh>
      <mesh castShadow position={[0, 1.12, -0.3]}>
        <boxGeometry args={[1.5, 0.45, 2.0]} />
        <meshStandardMaterial color={color} roughness={0.25} metalness={0.6} />
      </mesh>
      {[-0.78, 0.78].map((x) => (
        <mesh key={x} position={[x, 0.34, 1.35]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.34, 0.34, 0.26, 24]} />
          <meshStandardMaterial color="#111418" roughness={0.9} />
        </mesh>
      ))}
      {[-0.78, 0.78].map((x) => (
        <mesh key={`r${x}`} position={[x, 0.34, -1.35]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.34, 0.34, 0.26, 24]} />
          <meshStandardMaterial color="#111418" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function StudioLights({ hour = 12 }: { hour?: number }) {
  // Spec L1303: day and night lighting follow the local hour.
  const night = hour < 7 || hour >= 19;
  const key = night ? 0.9 : 1.6;
  const ambient = night ? 0.22 : 0.55;
  const sky = night ? '#31415e' : '#aad7ff';
  const accent = night ? '#7dd3fc' : '#22d3ee';
  return (
    <>
      <ambientLight intensity={ambient} />
      <directionalLight position={[6, 8, 4]} intensity={key} castShadow />
      <directionalLight position={[-6, 3, -4]} intensity={0.5} color={sky} />
      <pointLight position={[0, 3, -8]} intensity={0.4} color={accent} />
    </>
  );
}

export default function VehicleViewer({
  vehicle,
  state,
  preset,
  height = 380,
  interactive = true,
  className = '',
  hideDebugLabel = false,
}: {
  vehicle: VehicleWithState;
  state: VehicleState | null;
  preset?: GraphicsPreset;
  height?: number;
  interactive?: boolean;
  className?: string;
  hideDebugLabel?: boolean;
}) {
  const p = preset ?? autoPreset();
  const cfg = PRESETS[p];
  const [missing, setMissing] = useState(false);
  const [assetOk, setAssetOk] = useState<boolean | null>(null);
  const [glbLoaded, setGlbLoaded] = useState(false);
  const signal = useRef({ ok: false });
  // LOD: low/medium graphics presets load the decimated _lod variant that the
  // Blender pipeline emits alongside every class.
  const useLod = p === 'low' || p === 'medium';
  const base = `${vehicle.vehicleClass}${useLod ? '_lod' : ''}`;
  const [asset, setAsset] = useState(`/assets/models/${base}.glb`);

  useEffect(() => {
    let cancelled = false;
    void resolveAssetUrl(base).then((url) => {
      if (!cancelled) setAsset(url);
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  // Preflight the GLB before letting GLTFLoader fetch it, so a missing asset
  // degrades to the procedural fallback instead of a loader error.
  useEffect(() => {
    let cancelled = false;
    const url = asset;
    fetch(url, { method: 'HEAD' })
      .then((r) => {
        if (!cancelled) setAssetOk(r.ok);
      })
      .catch(() => {
        if (!cancelled) setAssetOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asset]);

  const useGlb = assetOk === true && !missing;

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-line bg-canvas ${className}`}
      style={{ height }}
      data-testid="vehicle-viewer"
      data-asset={useGlb && glbLoaded ? 'glb' : 'fallback'}
    >
      <Canvas
        dpr={cfg.pxRatio}
        shadows={cfg.shadows}
        gl={{
          antialias: p !== 'low',
          powerPreference: 'high-performance',
          failIfMajorPerformanceCaveat: false,
        }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
          });
        }}
        frameloop="always"
      >
        <CanvasBoundary height={height}>
          <PerspectiveCamera makeDefault position={classCamera(vehicle.vehicleClass)} fov={40} />
          <CameraRig target={classCamera(vehicle.vehicleClass)} />
          <StudioLights hour={new Date().getHours()} />
          <Suspense fallback={<FallbackVehicle vehicle={vehicle} state={state} />}>
            {useGlb ? (
              <ErrorBoundary3D onError={() => setMissing(true)}>
                <VehicleModel
                  url={asset}
                  vehicle={vehicle}
                  state={state}
                  preset={p}
                  signal={signal.current}
                  onLoaded={() => setGlbLoaded(true)}
                />
              </ErrorBoundary3D>
            ) : (
              <FallbackVehicle vehicle={vehicle} state={state} />
            )}
          </Suspense>
          {interactive && (
            <OrbitControls
              makeDefault
              enablePan={false}
              minDistance={3.2}
              maxDistance={16}
              maxPolarAngle={Math.PI * 0.62}
              autoRotate={!reducedMotion()}
              autoRotateSpeed={0.6}
            />
          )}
        </CanvasBoundary>
      </Canvas>
      {/* State overlays */}
      {state && (
        <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1.5">
          {state.chargingState === 'charging' && (
            <StatePill tone="charging" label={`${Math.round(state.chargePowerKw ?? 0)} kW`} />
          )}
          {state.status === 'asleep' && <StatePill tone="info" label="Asleep" />}
          {state.status === 'offline' && <StatePill tone="danger" label="Offline" />}
          {state.locked === false && <StatePill tone="warn" label="Unlocked" />}
          {state.trunkOpen && <StatePill tone="info" label="Trunk open" />}
          {state.frunkOpen && <StatePill tone="info" label="Frunk open" />}
          {state.alarmState === 'triggered' && <StatePill tone="danger" label="Security alert" />}
        </div>
      )}
      {state?.freshness === 'stale' || state?.freshness === 'last_known' ? (
        <div className="pointer-events-none absolute right-2 top-2">
          <StatePill
            tone={state.freshness === 'stale' ? 'warn' : 'danger'}
            label={state.freshness === 'stale' ? 'Stale data' : 'Last known'}
          />
        </div>
      ) : null}
      {!hideDebugLabel && (
        <div className="pointer-events-none absolute bottom-2 left-2 text-[10px] text-faint">
          WebGL · {p}
        </div>
      )}
    </div>
  );
}

function StatePill({ tone, label }: { tone: string; label: string }) {
  const tones: Record<string, string> = {
    charging: 'bg-charging/85 text-black',
    info: 'bg-info/85 text-black',
    danger: 'bg-danger/85 text-black',
    warn: 'bg-warn/85 text-black',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tones[tone] ?? tones.info}`}>
      {label}
    </span>
  );
}

class CanvasBoundary extends Component<
  { children: ReactNode; height: number },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className="flex h-full w-full items-center justify-center"
        style={{ height: this.props.height }}
        data-testid="vehicle-viewer"
      >
        <p className="text-xs text-faint">3D preview unavailable on this device</p>
      </div>
    );
  }
}

class ErrorBoundary3D extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
