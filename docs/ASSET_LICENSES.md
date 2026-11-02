# Asset licenses

Everything under `apps/web/public/3d/` (the staged, hashed GLBs) and
`blender/source/` is **original work created for VoltLink** by the `blender/`
pipeline and is licensed under the project's MIT license (see `LICENSE.md`).

- Vehicle geometry, materials and thumbnails: generated from scratch by
  `blender/scripts/generate_vehicle.py` — no imported meshes, no third-party
  model files.
- The fictional city map (streets, lake, parks) is procedurally generated in
  `apps/web/src/lib/map.ts` — no external tile sets or map data.
- Demo fleet names, makes and places are fictional.
- Fonts, icons and UI primitives come from the npm dependencies listed in
  `apps/web/package.json`, each under its own license
  (`lucide-react` — ISC; others per their packages). Run
  `npm audit` / license tooling in CI for the full dependency license report.
- No textures, photographs, or audio are bundled.

If you redistribute VoltLink assets, keep the MIT notice and do not present
the vehicles as real manufacturer products — the demo makes are fictional
(Halcyon, Cascade, Northline).
