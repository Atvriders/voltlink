# Blender asset pipeline

The five vehicle models are **original procedural assets** generated headlessly
by Blender 5.x — no external model downloads.

## Layout

```
blender/
  scripts/generate_vehicle.py   one generator, five classes + LOD flag
  scripts/render_thumb.py       orthographic thumbnail renderer
  scripts/validate_assets.py    GLB container + part-name validation
  rebuild_all.sh                orchestrator (generate → thumbs → manifest → validate)
apps/web/public/assets/models/
  <class>.glb, <class>_lod.glb  shipped assets
  thumbs/<class>.png            showroom thumbnails
  manifest.json                 per-asset stats (verts/tris/bytes)
```

## Classes

Five visibly distinct silhouettes, all Y-up glTF with named parts:

| Class               | Character                                      |
| ------------------- | ---------------------------------------------- |
| `compact_sedan`     | rounded hatch, low roof                        |
| `sport_sedan`       | low stance, swept nose, ducktail spoiler       |
| `compact_crossover` | raised ride height, roof rails                 |
| `suv`               | tall box, long roof, rails                     |
| `pickup`            | cab + open bed, high clearance, chunky fenders |

## Rebuild

```bash
BLENDER=~/.local/bin/blender blender/rebuild_all.sh
```

The script fails when Blender is missing, a part is missing, or validation
fails, and prints a polygon/file-size report.

## Export conventions

- Y-up glTF with identity node rotations (`export_yup=False` — see the
  generator header comment for why)
- `_lod` variants drop bevels and wheel segments (~25% lighter)
- Door/trunk/frunk/charge-port origins sit on their hinges so the viewer's
  rotations open them correctly
- `charge_connector` is an emissive element inside the charge port

## Validation

`validate_assets.py` (no Blender required) checks every GLB: container
structure, glTF version, JSON chunk, all 15 required part names, thumbnails,
and manifest consistency. CI runs it on every push.

## Editing the models

Tweak proportions in the per-class builder functions, run `rebuild_all.sh`,
and verify in the showroom (`/showroom`) — the viewer reflects the new assets
on the next build. Keep every required part name present or validation fails.
