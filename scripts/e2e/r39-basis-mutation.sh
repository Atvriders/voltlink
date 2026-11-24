#!/usr/bin/env bash
# R2-39 basis-chain mutation (webgl-2 #3): revert the parent-inverse fix in the
# generator, regenerate compact_sedan, and run the validator with its OWN exit
# code unmasked. Log gets the full header (command, diff, tree, HEAD, status).
set -uo pipefail
cd ~/voltlink
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
export BLENDER="${BLENDER:-$HOME/.local/bin/blender}"
LOG=~/voltlink-handoff/evidence/round2/v2/mutation/R2-39.basis-chain-inverse2.log
if [ -e "$LOG" ]; then echo "exists: $LOG"; exit 1; fi
python3 - <<'EOF'
p = 'blender/scripts/generate_vehicle.py'
s = open(p).read()
old = """    bpy.context.view_layer.update()
    child.matrix_parent_inverse = parent_obj.matrix_world.inverted()"""
new = """    bpy.context.view_layer.update()
    # mutant: the old basis-chain product misses ancestor parent-inverse terms
    child.matrix_parent_inverse = world_matrix(parent_obj).inverted()"""
assert old in s, 'anchor missing'
open(p, 'w').write(s.replace(old, new))
print('mutated')
EOF
{
  echo '== command =='
  echo 'blender --background --factory-startup --python-exit-code 1 --python blender/scripts/generate_vehicle.py -- --class compact_sedan --lod 0 --out /tmp/glb-test'
  echo '== mutant diff =='
  git diff blender/scripts/generate_vehicle.py
  echo '== tree =='
  git rev-parse --short HEAD
  git status --short
  echo '== run =='
  rm -rf /tmp/glb-test
  mkdir -p /tmp/glb-test
  "$BLENDER" --background --factory-startup --python-exit-code 1 \
    --python blender/scripts/generate_vehicle.py -- --class compact_sedan --lod 0 --out /tmp/glb-test 2>&1
  echo "blender exit=$?"
  echo '== validator =='
  echo 'node node_modules/tsx/dist/cli.mjs scripts/assets/validate.mts --staged /tmp/glb-test'
  node node_modules/tsx/dist/cli.mjs scripts/assets/validate.mts --staged /tmp/glb-test 2>&1
  echo "validator exit=$?"
} > "$LOG" 2>&1
git checkout -- blender/scripts/generate_vehicle.py
echo "LOG=$LOG"
tail -8 "$LOG"
