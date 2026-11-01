# build_environment.py — generate environment GLBs (guide 06 §4.5).
# Usage: blender --background --factory-startup --python-exit-code 1 \
#   --python blender/scripts/build_environment.py -- --env studio --out assets/models/env
#
# Conventions (match generate_vehicle.py):
#   glTF space x left, y up, z front; to_blender(x,y,z) = (x,-z,y); exporter swizzles back.
#   Articulated/prop anchors are EMPTIES with extras {"voltlink":{kind,role}}.
#   vehicle_spot (0,0,0) is where the vehicle glTF is instanced.
#   Budget: every environment <= 60k tris, untextured PBR materials.

import argparse
import bpy
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TO_BLENDER = None  # avoid circular import; generate_vehicle has helpers but also builds a car.


def to_blender(x, y, z):
    # glTF (x left, y up, z front) -> Blender (x, -z, y)
    return (x, -z, y)


def env_root():
    return {
        "studio": {"floor": (14, 10), "accent": (0.10, 0.12, 0.16)},
        "garage": {"floor": (10, 8), "accent": (0.09, 0.10, 0.11)},
        "charging_bay": {"floor": (12, 9), "accent": (0.06, 0.42, 0.36)},
        "fleet_depot": {"floor": (16, 12), "accent": (0.10, 0.11, 0.13)},
        "diagnostic": {"floor": (12, 10), "accent": (0.55, 0.28, 0.10)},
    }


def mat(name, rgba):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgba, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.85
    return m


def box(name, sx, sy, sz, cx, cy, cz, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, cz))
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (sx, sy, sz)
    ob.data.materials.append(material)
    return ob


def empty(name, loc, role):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = "PLAIN_AXES"
    ob.location = loc
    ob["voltlink"] = {"kind": "environment_anchor", "role": role, "specVersion": 1}
    bpy.context.collection.objects.link(ob)
    return ob


def build(env_name, out_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    spec = env_root()[env_name]
    fx, fz = spec["floor"]
    accent = spec["accent"]

    floor = mat(f"{env_name}_floor", (0.13, 0.13, 0.13))
    wall = mat(f"{env_name}_wall", (0.16, 0.16, 0.16))
    pedestal = mat(f"{env_name}_pedestal", accent)

    box(f"{env_name}_ground", fx, 0.10, fz, 0, -0.05, 0, floor)
    box(f"{env_name}_backwall", fx, 3.2, 0.12, 0, 1.6, -fz / 2 + 0.06, wall)

    if env_name == "garage":
        box(f"{env_name}_side_l", 0.16, 3.2, fz, -fx / 2 + 0.08, 1.6, 0, wall)
        box(f"{env_name}_side_r", 0.16, 3.2, fz, fx / 2 - 0.08, 1.6, 0, wall)
    elif env_name == "fleet_depot":
        box(f"{env_name}_side_l", 0.16, 3.2, fz, -fx / 2 + 0.08, 1.6, 0, wall)
        box(f"{env_name}_bay_divider", 0.10, 2.4, fz, fx / 6, 1.2, 0, wall)

    # Charger pedestal to the right-front of the vehicle spot (all envs).
    box(f"{env_name}_charger_pedestal", 0.55, 1.5, 0.35, fx / 2 - 1.2, 0.75, fz / 2 - 1.0, pedestal)

    # Anchors: where the vehicle glTF is instanced, plus camera empties.
    empty("vehicle_spot", (0, 0, 0), "vehicle_spot")
    for i, shot in enumerate(("front_quarter", "rear_quarter", "side", "top")):
        ang = math.radians(45 + i * 45)
        r = 9.0
        cam = to_blender(r * math.sin(ang), 2.2, r * math.cos(ang))
        empty(f"camera_{shot}", cam, "camera")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    os.makedirs(out_path, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(out_path, f"{env_name}.glb"),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        use_selection=False,
    )
    print(f"wrote {env_name}.glb")


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True)
    ap.add_argument("--out", default="assets/models/env")
    args = ap.parse_args(argv)
    build(args.env, args.out)
