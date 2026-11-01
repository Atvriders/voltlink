# Blender asset pipeline (guide 06)

Single source of truth: `blender/specs/vehicle_classes.json` — six vehicle
classes with envelopes, wheel/tire specs, doors, closures, ports and triangle
budgets. Everything downstream (generator, validator, docs) reads this file.

## Coordinate & articulation conventions

- glTF space: **x left, y up, z front**. Blender builder converts with
  `to_blender(x,y,z) = (x, -z, y)`; the exporter swizzles back.
- Articulated parts are **EMPTY pivots** (identity rotation/scale, position on
  the hinge) with mesh children. Pivot nodes carry extras:
  `{"voltlink": {kind, axis, openDeg, distance, hideAtOpen, class, lod, specVersion}}`.
- `kind`: `rotate` (doors, frunk, trunk, liftgate, tailgate), `slide` (windows),
  `translate` (charge port), `spin` (wheels). Positive rotation opens outward.

## Pipeline (regenerate everything)

```bash
blender/rebuild_all.sh   # or:
BLENDER=blender bash blender/rebuild_all.sh
```

Steps: generate 6 classes × 3 LODs (`generate_vehicle.py`), 5 environments
(`build_environment.py`), then `scripts/assets/postprocess.ts` (gltf-transform
dedup → prune --keep-leaves → meshopt), `scripts/assets/validate.mts`
(C-ASSETVALID, fails the build on any violation), and `scripts/assets/stage.ts`
(hashes files into `apps/web/public/3d/<name>.<sha256:10>.glb` +
`manifest.json`). `apps/web` runs postprocess+stage via its `prebuild`/`predev`
hooks.

## Server & viewer

- API serves `/3d/manifest.json` with `Cache-Control: no-cache` and `/3d/*` as
  immutable (1y) static files; missing 3D files are 404, never the SPA shell.
- `apps/web/src/webgl/vehicleAssets.ts` resolves classes through the manifest;
  `articulation.ts` applies poses purely from node extras.
- Budgets (lod0 60k–110k tris ≤3.5 MB, lod1 ≤40k, lod2 ≤12k; environments
  ≤60k) are enforced by the validator and checked in CI.

## Verification

- `npx tsx scripts/assets/validate.mts` → 0 failures on all 23 GLBs.
- Playwright projects `webgl-swiftshader` (software GL) and `no-webgl`
  (graceful degradation) exercise the showroom both ways.
- `packages/shared/src/validate-assets.test.ts` runs the validator against
  good and deliberately corrupted fixtures.
