#!/usr/bin/env bash
# rebuild_all.sh — regenerate every vehicle class at every LOD, the
# environments, then postprocess, validate, and stage into the web app
# (guide 06 §7). Aborts on the first failing step.
set -euo pipefail
cd "$(dirname "$0")/.."

BLENDER=${BLENDER:-blender}
CLASSES=(compact_sedan sport_sedan compact_crossover suv pickup fallback)
ENVS=(studio garage charging_bay fleet_depot diagnostic)

for cls in "${CLASSES[@]}"; do
  for lod in 0 1 2; do
    "$BLENDER" --background --factory-startup --python-exit-code 1 \
      --python blender/scripts/generate_vehicle.py -- --class "$cls" --lod "$lod" --out assets/models
  done
done
for env in "${ENVS[@]}"; do
  "$BLENDER" --background --factory-startup --python-exit-code 1 \
    --python blender/scripts/build_environment.py -- --env "$env" --out assets/models/env
done

npx tsx scripts/assets/postprocess.ts
npx tsx scripts/assets/validate.mts
npx tsx scripts/assets/stage.ts
echo "rebuild_all: OK"
