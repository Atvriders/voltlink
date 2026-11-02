# WebGL vehicle viewer

The Showroom and Live vehicle pages render vehicles in WebGL (React Three
Fiber + three.js).

## Model loading

1. The viewer resolves `/assets/models/<vehicleClass>.glb` (or
   `<vehicleClass>_lod.glb` for the `low`/`medium` graphics presets).
2. A `HEAD` preflight verifies the asset exists. Missing or unloadable assets
   degrade to the built-in **procedural fallback silhouette** — never a blank
   screen.
3. A `CanvasBoundary` catches WebGL/context failures and renders a labelled
   "3D preview unavailable" panel.

## State-aware animation

The model's named parts follow live vehicle state every frame:

- doors (`door_fl/fr/rl/rr`) rotate open around their hinges
- trunk and frunk open, charge port door swings
- charge connector appears and pulses cyan while charging
- headlights/taillights track climate, driving and flash states
- security alert flashes the body red
- offline dims the whole vehicle

## Graphics presets

`auto` derives a preset from hardware concurrency and device memory; presets
`low/medium/high/ultra` control pixel ratio, shadows and LOD selection.

## Context loss & cleanup

Context-loss events are caught and recovered; components dispose GPU resources
on unmount.

## Camera, paint and lighting

Every vehicle class gets its own camera framing with smooth transitions; the
body mesh is tinted with the vehicle's real paint color; studio lighting
follows the local hour (day/night).

## Reduced motion

The viewer respects the system reduced-motion preference (no continuous
auto-rotation beyond state-driven animation).

## Part naming convention

Assets are validated at build time to contain: `body`, `windows`, `wheels`,
`mirrors`, `interior`, `door_fl`, `door_fr`, `door_rl`, `door_rr`, `trunk`,
`frunk`, `charge_port`, `charge_connector`, `headlights`, `taillights`.
See [Blender assets](BLENDER_ASSETS.md).
