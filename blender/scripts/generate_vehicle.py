# VoltLink vehicle asset generator — spec-driven, pivot/extras conventions per
# guide 06 §1-§4. Authoring in glTF space (x left, y up, z front, metres);
# every position is converted once with to_blender().
# Usage: blender --background --factory-startup --python-exit-code 1 \
#          --python generate_vehicle.py -- --class suv [--lod 0|1|2] [--out dir]

import argparse
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector, Matrix

SPEC = None
LOD = 0
OUT = "assets/models"


def to_blender(p):
    """glTF (x left, y up, z front) -> Blender (x, -z, y)."""
    return Vector((p[0], -p[2], p[1]))


def parse_args():
    global SPEC, LOD, OUT
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--class", required=True)
    ap.add_argument("--lod", type=int, default=0)
    ap.add_argument("--out", default="assets/models")
    a = ap.parse_args(argv)
    LOD = a.lod
    OUT = a.out
    spec_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "specs", "vehicle_classes.json")
    with open(spec_path, "r", encoding="utf-8") as f:
        SPEC = json.load(f)["classes"][a.__dict__["class"]]


def clear_scene():
    for block in list(bpy.data.objects):
        bpy.data.objects.remove(block, do_unlink=True)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m, do_unlink=True)
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m, do_unlink=True)


MAT_CACHE = {}


def mat(name, base, metallic=0.0, roughness=0.5, emission=None, emission_strength=1.0, transmission=0.0):
    key = (name, tuple(base), metallic, roughness, emission, emission_strength, transmission)
    if key in MAT_CACHE:
        return MAT_CACHE[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = m.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (base[0], base[1], base[2], 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if transmission > 0:
        bsdf.inputs["Transmission Weight"].default_value = transmission
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (emission[0], emission[1], emission[2], 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    MAT_CACHE[key] = m
    return m


def box_mesh(name, size_gltf, center_gltf=(0, 0, 0), material=None):
    sx, sy, sz = size_gltf
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = []
    for ix in (-1, 1):
        for iy in (-1, 1):
            for iz in (-1, 1):
                verts.append(bm.verts.new(to_blender((ix * sx / 2, iy * sy / 2, iz * sz / 2))))
    bm.verts.ensure_lookup_table()
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for f in faces:
        try:
            bm.faces.new([bm.verts[i] for i in f])
        except ValueError:
            pass
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = to_blender(center_gltf)
    if material is not None:
        ob.data.materials.append(material)
    return ob


def empty(name, location_gltf=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = to_blender(location_gltf)
    return ob


def pivot(name, location_gltf, extras):
    ob = empty(name, location_gltf)
    ob["voltlink"] = extras
    return ob


def world_matrix(obj):
    """Recursive world transform from basis matrices (depsgraph-free)."""
    if obj.parent:
        return world_matrix(obj.parent) @ obj.matrix_basis
    return obj.matrix_basis.copy()


def parent(child, parent_obj):
    child.parent = parent_obj
    # Blender's cached matrix_world can be stale inside a headless script;
    # compute the parent world recursively and set the inverse explicitly so
    # the exported local transform is identity for meshes moved to their pivot.
    child.matrix_parent_inverse = world_matrix(parent_obj).inverted()


def shift_origin(obj, new_origin_gltf):
    # Keep the mesh where it is in the world and move the origin onto the
    # hinge: vertices are translated by (old_origin - new_origin), so a point
    # that sat at the hinge now sits at local zero.
    delta = obj.location - to_blender(new_origin_gltf)
    obj.data.transform(Matrix.Translation(delta))
    obj.location = to_blender(new_origin_gltf)


def build_wheels(spec, tire_od, track, wheelbase, front_z, mat_tire, mat_rim, mat_brake):
    group = empty("wheels")
    half_w = spec["tire"]["widthMm"] / 2000.0
    radius = tire_od / 2.0
    for side, sx in (("l", 1), ("r", -1)):
        for ax, az in (("f", front_z), ("r", front_z - wheelbase)):
            name = f"wheel_{ax}{side}"
            piv = pivot(name, (sx * track / 2, radius, az), {"kind": "spin", "axis": [1, 0, 0], "radiusM": radius})
            parent(piv, group)
            tire = box_mesh(f"tire_{ax}{side}", (2 * half_w, 2 * radius, 2 * radius), (sx * track / 2, radius, az), mat_tire)
            parent(tire, piv)
            rim_hw = half_w - 0.015
            rim = box_mesh(f"rim_{ax}{side}", (2 * rim_hw, 2 * (radius - 0.09), 2 * (radius - 0.09)), (sx * track / 2, radius, az), mat_rim)
            parent(rim, piv)
            brake = box_mesh(f"brake_{ax}{side}", (2 * (half_w - 0.06), 2 * (radius - 0.16), 2 * (radius - 0.16)), (sx * track / 2, radius, az), mat_brake)
            parent(brake, piv)
    return group


def _interp(table, z):
    # table: [[z, v], ...] sorted by z descending
    if z >= table[0][0]:
        return table[0][1]
    if z <= table[-1][0]:
        return table[-1][1]
    for (z1, v1), (z2, v2) in zip(table, table[1:]):
        if z2 <= z <= z1:
            t = (z - z1) / (z2 - z1) if z2 != z1 else 0.0
            return v1 + t * (v2 - v1)
    return table[-1][1]


def build_skin_body(spec, paint, tire_od, wheelbase, front_z, track):
    """Body surface sampled from the spec profile/plan tables, with wheel-arch
    holes cut by skipping stations inside the tire cylinders (ASSETS-03)."""
    env = spec["envelope"]
    L, gc = env["length"], env["groundClearance"]
    top = sorted(spec["profile"]["top"], key=lambda p: -p[0])
    bottom = sorted(spec["profile"]["bottom"], key=lambda p: -p[0])
    belt = sorted(spec["profile"]["belt"], key=lambda p: -p[0])
    plan = sorted(spec["plan"]["halfWidth"], key=lambda p: -p[0])
    tumble = sorted(spec["plan"]["tumblehome"], key=lambda p: -p[0])
    z0, z1 = -L / 2, L / 2
    stations = [z0 + (z1 - z0) * i / 16 for i in range(17)]
    # Insert every profile breakpoint so peaks/edges land on exact stations.
    for table in (top, bottom, belt, plan):
        for p in table:
            if z0 < p[0] < z1:
                stations.append(p[0])
    stations = sorted(set(round(z, 4) for z in stations))
    rows = 5
    radius = tire_od / 2 + 0.04
    arch_centers = [(track / 2, front_z), (track / 2, front_z - wheelbase)]
    verts_by_station = []
    for z in stations:
        y_bot = _interp(bottom, z)
        y_top = _interp(top, z)
        belt_y = _interp(belt, z)
        half_w = _interp(plan, z)
        th = _interp(tumble, z)
        row_verts = []
        for j in range(rows):
            y = y_bot + (y_top - y_bot) * j / (rows - 1)
            x = half_w if y <= belt_y else half_w - th
            for sx in (1, -1):
                skip = False
                for (ax, az) in arch_centers:
                    if abs(sx * x) > 0.3 and math.hypot(y - tire_od / 2, z - az) < radius + 0.15:
                        skip = True
                if skip:
                    row_verts.append(None)
                else:
                    row_verts.append((sx * x, y, z))
        verts_by_station.append(row_verts)
    me = bpy.data.meshes.new("body_mesh")
    bm = bmesh.new()
    bv = []
    for row in verts_by_station:
        for v in row:
            bv.append(bm.verts.new(to_blender(v)) if v else None)
    for si in range(len(stations) - 1):
        for j in range(rows - 1):
            for side in (0, 1):
                a = bv[si * (rows * 2) + j * 2 + side]
                b = bv[si * (rows * 2) + (j + 1) * 2 + side]
                c = bv[(si + 1) * (rows * 2) + (j + 1) * 2 + side]
                d = bv[(si + 1) * (rows * 2) + j * 2 + side]
                if None in (a, b, c, d):
                    continue
                try:
                    bm.faces.new([a, b, c, d])
                except ValueError:
                    pass
    # front and rear caps
    for si in (0, len(stations) - 1):
        for j in range(rows - 1):
            a = bv[si * (rows * 2) + j * 2]
            b = bv[si * (rows * 2) + (j + 1) * 2]
            c = bv[si * (rows * 2) + (j + 1) * 2 + 1]
            d = bv[si * (rows * 2) + j * 2 + 1]
            if None in (a, b, c, d):
                continue
            try:
                bm.faces.new([a, b, c, d])
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("body_mesh", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(paint)
    return ob


def build_body(spec, paint, trim_m, glass, tire_od, front_z):
    env = spec["envelope"]
    L, W, H, gc = env["length"], env["width"], env["height"], env["groundClearance"]
    root = empty("body")
    body = build_skin_body(spec, paint, tire_od, env["wheelbase"], front_z, env["track"][0])
    parent(body, root)
    trim = box_mesh("trim_mesh", (W - 0.10, 0.10, L - 0.20), (0, gc + 0.04, 0), trim_m)
    parent(trim, root)
    under = box_mesh("underbody_mesh", (W - 0.40, 0.02, L - 0.60), (0, gc + 0.01, 0), trim_m)
    parent(under, root)
    wells = box_mesh("wheel_well_mesh", (W - 0.30, 0.30, 1.4), (0, gc + 0.45, 0), trim_m)
    parent(wells, root)
    # Greenhouse sits under the roof profile, never above it.
    top_table = sorted(spec["profile"]["top"], key=lambda p: -p[0])
    cab_z0, cab_z1 = -L * 0.28, L * 0.16
    roof_ys = [_interp(top_table, z) for z in (cab_z0, cab_z1)]
    y_roof = min(roof_ys)
    greenhouse_h = H * 0.42
    cab = box_mesh("cab_mesh", (W * 0.86, greenhouse_h, cab_z1 - cab_z0), (0, y_roof - greenhouse_h / 2, (cab_z0 + cab_z1) / 2), glass)
    parent(cab, root)
    return root


def main():
    parse_args()
    clear_scene()
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    cls_name = argv[argv.index("--class") + 1]
    spec = SPEC
    env = spec["envelope"]
    L, W, H = env["length"], env["width"], env["height"]
    gc = env["groundClearance"]
    wheelbase = env["wheelbase"]
    front_z = L / 2 - env["frontOverhang"]
    track = env["track"][0]
    tire = spec["tire"]
    tire_od = (tire["rimIn"] * 25.4 + 2 * tire["widthMm"] * tire["aspect"] / 100) / 1000.0

    paint = mat("paint", (0.13, 0.31, 0.46), metallic=0.55, roughness=0.3)
    trim_m = mat("trim", (0.09, 0.10, 0.11), roughness=0.8)
    glass = mat("glass", (0.05, 0.07, 0.09), roughness=0.1, transmission=0.85)
    seat_m = mat("seat", (0.16, 0.15, 0.14), roughness=0.9)
    dash_m = mat("dash", (0.07, 0.07, 0.08), roughness=0.7)
    rim_m = mat("rim", (0.78, 0.8, 0.82), metallic=0.9, roughness=0.25)
    brake_m = mat("brake", (0.4, 0.4, 0.42), metallic=0.8, roughness=0.4)
    tire_m = mat("tire", (0.05, 0.05, 0.05), roughness=0.95)
    lamp_m = mat("lamp", (0.9, 0.95, 1.0), emission=(0.85, 0.92, 1.0), emission_strength=2.0)
    tail_m = mat("tail", (0.9, 0.1, 0.08), emission=(0.9, 0.08, 0.06), emission_strength=2.0)
    port_m = mat("port", (0.1, 0.12, 0.14), emission=(0.13, 0.83, 0.93), emission_strength=1.5)

    root = empty("vehicle_root")
    root["voltlink"] = {"kind": "asset", "class": cls_name, "lod": LOD, "specVersion": 1}

    body = build_body(spec, paint, trim_m, glass, tire_od, front_z)
    parent(body, root)

    windows = empty("windows")
    windshield = box_mesh("windshield", (W * 0.80, 0.55, 0.05), (0, gc + H * 0.72, front_z + 0.15), glass)
    windshield.rotation_euler = (math.radians(-38), 0, 0)
    parent(windshield, windows)
    rear = box_mesh("rear_glass", (W * 0.74, 0.42, 0.05), (0, gc + H * 0.70, -L / 2 + 0.35), glass)
    rear.rotation_euler = (math.radians(32), 0, 0)
    parent(rear, windows)
    for side, sx in (("l", 1), ("r", -1)):
        w = box_mesh(f"window_fixed_{side}", (0.04, 0.30, 1.3), (sx * W * 0.42, gc + H * 0.68, -0.15), glass)
        parent(w, windows)
    parent(windows, root)

    mirrors = empty("mirrors")
    for side, sx in (("l", 1), ("r", -1)):
        m = box_mesh(f"mirror_{side}", (0.09, 0.10, 0.16), (sx * (W / 2 + 0.05), gc + H * 0.62, front_z + 0.25), paint)
        parent(m, mirrors)
    parent(mirrors, root)

    wheels = build_wheels(spec, tire_od, track, wheelbase, front_z, tire_m, rim_m, brake_m)
    parent(wheels, root)

    doors_group = empty("doors")
    half_w = W / 2 - 0.05
    for d in spec["doors"]:
        side_sign = 1 if d["side"] == "left" else -1
        z0, z1 = d["z"]
        y0, y1 = d["y"]
        hinge_z = z1 if d["hinge"] == "front" else z0
        hinge_gltf = (side_sign * half_w, y1 - 0.02, hinge_z)
        piv = pivot(d["id"], hinge_gltf, {"kind": "hinge", "axis": [0, 1, 0], "openDeg": d["openDeg"], "state": d["id"]})
        parent(piv, doors_group)
        mesh = box_mesh(f"{d['id']}_mesh", (0.05, y1 - y0, z1 - z0), (side_sign * half_w, (y0 + y1) / 2, (z0 + z1) / 2), paint)
        shift_origin(mesh, hinge_gltf)
        parent(mesh, piv)
        win_name = f"window_{d['id'][-2:]}"
        win = pivot(win_name, hinge_gltf, {"kind": "slide", "axis": [0, -1, 0], "distance": 0.045, "state": win_name})
        parent(win, piv)
        wmesh = box_mesh(f"{win_name}_mesh", (0.03, 0.30, z1 - z0 - 0.3), (side_sign * (half_w - 0.01), (y0 + y1) / 2 + 0.18, (z0 + z1) / 2), glass)
        parent(wmesh, win)
    parent(doors_group, root)

    rc = spec["rearClosure"]
    if rc["id"] == "tailgate":
        rc_hinge = (0, rc["y"][0], (rc["z"][0] + rc["z"][1]) / 2)
    else:
        # trunk/liftgate hinge lies in the lid plane: top edge, mid-thickness
        rc_hinge = (0, rc["y"][1], (rc["z"][0] + rc["z"][1]) / 2)
    rp = pivot(rc["id"], rc_hinge, {"kind": "hinge", "axis": [1, 0, 0], "openDeg": rc["openDeg"], "state": "rear_closure"})
    parent(rp, root)
    if rc["id"] == "trunk":
        # horizontal deck lid: long in z, thin in y, top face at the hinge line
        rmesh = box_mesh("trunk_mesh", (W * 0.86, 0.06, rc["z"][1] - rc["z"][0]), (0, rc["y"][1], (rc["z"][0] + rc["z"][1]) / 2), paint)
    else:
        rmesh = box_mesh(f"{rc['id']}_mesh", (W * 0.86, rc["y"][1] - rc["y"][0], 0.06), (0, (rc["y"][0] + rc["y"][1]) / 2, (rc["z"][0] + rc["z"][1]) / 2), paint)
    shift_origin(rmesh, rc_hinge)
    parent(rmesh, rp)

    fr = spec["frunk"]
    fr_hinge = (0, gc + H * 0.42, fr["z"][1])
    fp = pivot("frunk", fr_hinge, {"kind": "hinge", "axis": [1, 0, 0], "openDeg": fr["openDeg"], "state": "frunk"})
    parent(fp, root)
    fmesh = box_mesh("frunk_mesh", (W * 0.76, 0.04, fr["z"][1] - fr["z"][0]), (0, gc + H * 0.42, (fr["z"][0] + fr["z"][1]) / 2), paint)
    shift_origin(fmesh, fr_hinge)
    parent(fmesh, fp)

    cp = spec["chargePort"]
    cp_x = (W / 2 - 0.03) if cp["side"] == "left" else -(W / 2 - 0.03)
    cp_hinge = (cp_x, cp["y"], cp["z"] + 0.05)
    cpp = pivot("charge_port", cp_hinge, {"kind": "hinge", "axis": [0, 1, 0], "openDeg": cp["openDeg"], "state": "charge_port"})
    parent(cpp, root)
    cpmesh = box_mesh("charge_port_mesh", (0.02, cp["size"][1], cp["size"][0]), (cp_x, cp["y"], cp["z"]), port_m)
    shift_origin(cpmesh, cp_hinge)
    parent(cpmesh, cpp)
    inlet = box_mesh("charge_inlet", (0.06, 0.10, 0.10), (cp_x - 0.03 if cp["side"] == "left" else cp_x + 0.03, cp["y"], cp["z"]), trim_m)
    parent(inlet, root)
    led = box_mesh("charge_port_led", (0.02, 0.02, 0.05), (cp_x, cp["y"] + 0.06, cp["z"]), lamp_m)
    parent(led, root)
    dock = empty("charge_dock", (cp_x - 1.2 if cp["side"] == "left" else cp_x + 1.2, cp["y"], cp["z"]))
    parent(dock, root)
    conn_x = cp_x - 0.05 if cp["side"] == "left" else cp_x + 0.05
    conn_piv = pivot("charge_connector", (conn_x, cp["y"], cp["z"]), {"kind": "slide", "axis": [1, 0, 0], "distance": 0.16, "state": "connector", "hideAtOpen": True})
    parent(conn_piv, root)
    conn = box_mesh("charge_connector_mesh", (0.08, 0.09, 0.09), (conn_x, cp["y"], cp["z"]), port_m)
    parent(conn, conn_piv)
    cable = box_mesh("charging_cable_mesh", (1.2, 0.02, 0.02), (cp_x - 0.6 if cp["side"] == "left" else cp_x + 0.6, cp["y"] - 0.05, cp["z"]), trim_m)
    parent(cable, conn_piv)

    headlights = empty("headlights")
    for side, sx in (("l", 1), ("r", -1)):
        h = box_mesh(f"headlight_{side}", (0.20, 0.08, 0.30), (sx * (W / 2 - 0.25), gc + H * 0.42, L / 2 - 0.02), lamp_m)
        parent(h, headlights)
    parent(headlights, root)
    taillights = empty("taillights")
    brake_lights = empty("brake_lights")
    for side, sx in (("l", 1), ("r", -1)):
        t = box_mesh(f"taillight_{side}", (0.18, 0.08, 0.12), (sx * (W / 2 - 0.22), gc + H * 0.55, -L / 2 + 0.02), tail_m)
        parent(t, taillights)
        b = box_mesh(f"brake_{side}", (0.16, 0.06, 0.06), (sx * (W / 2 - 0.22), gc + H * 0.55, -L / 2 + 0.02), tail_m)
        parent(b, brake_lights)
    parent(taillights, root)
    parent(brake_lights, root)

    interior = empty("interior")
    dash = box_mesh("dash", (W * 0.62, 0.16, 0.30), (0, gc + 0.72, front_z + 0.05), dash_m)
    parent(dash, interior)
    for side, sx in (("l", 1), ("r", -1)):
        s = box_mesh(f"seat_{side}", (0.48, 0.5, 0.5), (sx * 0.36, gc + 0.66, front_z - 0.25), seat_m)
        parent(s, interior)
    rear_seat = box_mesh("seat_rear", (W * 0.5, 0.46, 0.44), (0, gc + 0.64, front_z - 0.85), seat_m)
    parent(rear_seat, interior)
    wheel = empty("steering_wheel", (0.36, gc + 0.78, front_z + 0.35))
    wheel["voltlink"] = {"kind": "hotspot", "id": "steering_wheel", "label": "Steering wheel"}
    parent(wheel, interior)
    sw = box_mesh("steering_wheel_mesh", (0.04, 0.36, 0.36), (0.36, gc + 0.78, front_z + 0.35), trim_m)
    sw.rotation_euler = (0, 0, math.radians(-20))
    parent(sw, wheel)
    battery = box_mesh("battery_mesh", (W * 0.6, 0.14, wheelbase * 0.7), (0, gc - 0.04, front_z - wheelbase / 2), trim_m)
    parent(battery, interior)
    parent(interior, root)

    cp_hot = empty("hotspot_charge_port", (cp_x, cp["y"], cp["z"]))
    cp_hot["voltlink"] = {"kind": "hotspot", "id": "charge_port", "label": "Charge port"}
    parent(cp_hot, root)

    levels = 3 if LOD == 0 else 2 if LOD == 1 else 1
    for ob in list(bpy.data.objects):
        if ob.type == "MESH":
            lv = 4 if (LOD == 0 and ob.name == "body_mesh") else levels
            sub = ob.modifiers.new(f"lod{LOD}_subdiv", "SUBSURF")
            # SIMPLE subdivides the cage without rounding, so boxes keep their
            # exact dimensions (Catmull-Clark would shrink the bbox ~16%).
            sub.subdivision_type = "SIMPLE"
            sub.levels = lv
            sub.render_levels = lv

    os.makedirs(OUT, exist_ok=True)
    os.makedirs("blender/source", exist_ok=True)
    out_path = os.path.join(OUT, f"{cls_name}{'' if LOD == 0 else '_lod' if LOD == 1 else '_lod2'}.glb")
    # Refresh the depsgraph so matrix_world is correct for every object; the
    # glTF exporter computes child transforms from parent world matrices.
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join("blender/source", f"{cls_name}.blend"), compress=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_extras=True,
        export_lights=False,
        export_cameras=False,
        export_animations=False,
        export_draco_mesh_compression_enable=False,
        export_meshopt_compression_enable=False,
    )
    print(json.dumps({"blender": bpy.app.version_string, "class": cls_name, "lod": LOD, "out": out_path}))


if __name__ == "__main__":
    main()
