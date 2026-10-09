#!/usr/bin/env python3
"""FIRE Fantasy 20's car and liveries for the site's livery picker.

FF20 paints every livery onto its own car models through the model's UVs: its LiveryShader
samples _BaseLivery and _DetailLivery at UV0 whatever the livery's projection says, and mixes the
team colours as primary -> trim (blue) -> secondary (red) -> tertiary (green). So a flat side
texture can't preview them; this renders them from the real model instead.

For one car model (MM_Data/Modding/Models/Vehicle/<model>, e.g. F1) it writes, into <out>:
  ff20-<model>-car.glb           the car for the 3D view: the livery body (UVs, normals), the
                                 sponsor decals (UVs, material "SponsorNN" = sticker slot NN - 1, as
                                 the league game patch maps them) and the other parts in flat colours
                                 (glass left out)
  ff20-<model>-overlay.png       the side view's shading and non-livery parts, drawn over a mask
  ff20-<model>-<livery>.png      per livery: the side view's colour key (alpha 0 off the body)
  ff20-uv-<livery>.png           per livery: base + detail key at 1024x1024, for the 3D car

<livery> is the livery's base and detail texture names (src/ops/team.ts, ff20LiveryKey). Liveries
come from MM's Liveries table (textures in resources.assets / the Livery Pack DLC bundle) and
FF20's Images/liverypack (LiveryBase_<n>, LiveryDetail_<n>).

These are game assets: they go to the site's "liveries" bucket (`mmsave liveries`), not the repo.

  tools/ff20-car-renders.py <MM_Data folder> <out folder> [model=F1]

Needs UnityPy and numpy.
"""
import csv
import io
import json
import os
import re
import struct
import sys

import numpy as np
import UnityPy
from PIL import Image
from UnityPy.helpers.MeshHelper import MeshHandler

PREFIX = "carcustomisation/liverytextures/"
DLC_PREFIX = "assets/editor/assetbundleresources/livery_pack_dlc/"
ROOT = "Chassis_Championship0"  # the frontend car (the race one is Chassis_RaceSim_Championship0)
RENDER = (1024, 256)
MASK = (512, 128)
UV_SIZE = 1024

# Flat colours for the parts that aren't livery, by material (linear-ish sRGB 0..1).
PART_COLOURS = {
    "TYRES_THREAD": (0.09, 0.09, 0.09), "TYRES_TYPE_SOFT00": (0.12, 0.12, 0.12),
    "Mat_rs17_carbon": (0.08, 0.08, 0.09), "Mat": (0.07, 0.07, 0.07), "Mat.3.1": (0.07, 0.07, 0.07),
    "Mat_rs17_mirror": (0.1, 0.1, 0.1), "rb_wheel": (0.16, 0.17, 0.17), "Mat_rs17_redlight": (0.8, 0.05, 0.05),
    "Helmet_stuff": (0.45, 0.45, 0.47), "Material#4": (0.35, 0.35, 0.35), "Mat_rs17_body": (0.9, 0.8, 0.1),
}
SKIP = {"Mat_rs17_glass"}
LIVERY_MATERIAL = "Livery"
SPONSOR_MATERIAL = re.compile(r"^Sponsor0[1-6]$")


def slug(name):
    return re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-")


def livery_key(base, detail):
    """Mirrors ff20LiveryKey in src/ops/team.ts."""
    return slug(base) + "--" + slug(detail)


# ---------------------------------------------------------------------------------------------
# The car: world-space geometry per material

def quat_matrix(q):
    x, y, z, w = q.x, q.y, q.z, q.w
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def local_matrix(t):
    m = np.eye(4)
    s = np.diag([t.m_LocalScale.x, t.m_LocalScale.y, t.m_LocalScale.z])
    m[:3, :3] = quat_matrix(t.m_LocalRotation) @ s
    m[:3, 3] = [t.m_LocalPosition.x, t.m_LocalPosition.y, t.m_LocalPosition.z]
    return m


def component(go, class_id):
    for cid, ptr in go.m_Component:
        if cid == class_id and ptr.path_id:
            return ptr.read()
    return None


def car_parts(bundle, sponsors=None):
    """{material: [(positions Nx3, normals Nx3, uvs Nx2 | None, triangles Mx3)]} in world space.
    The sponsor decals go into `sponsors` (same shape) if given, and are left out otherwise."""
    env = UnityPy.load(bundle)
    root = next(o.read() for o in env.objects if o.type.name == "GameObject" and o.peek_name() == ROOT)
    parts = {}

    def walk(t, parent, decal=False):
        go = t.m_GameObject.read()
        decal = decal or go.m_Name.startswith("Sponsor")
        if not go.m_IsActive or (decal and sponsors is None):
            return
        into = sponsors if decal else parts
        world = parent @ local_matrix(t)
        mf, mr = component(go, 33), component(go, 23)
        if mf and mr and mf.m_Mesh.path_id:
            mesh = mf.m_Mesh.read()
            h = MeshHandler(mesh)
            h.process()
            pos = np.array(h.m_Vertices, dtype=np.float64).reshape(-1, 3)
            nrm = np.array(h.m_Normals, dtype=np.float64).reshape(-1, 3) if h.m_Normals else np.zeros_like(pos)
            uv = np.array(h.m_UV0, dtype=np.float64).reshape(-1, 2) if h.m_UV0 else None
            pos = (world[:3, :3] @ pos.T).T + world[:3, 3]
            nrm = (np.linalg.inv(world[:3, :3]).T @ nrm.T).T
            nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
            index = np.array(h.m_IndexBuffer, dtype=np.int64)
            mats = [m.read().m_Name if m.path_id else None for m in mr.m_Materials]
            for i, sub in enumerate(mesh.m_SubMeshes):
                mat = mats[min(i, len(mats) - 1)]
                if mat is None or mat in SKIP:
                    continue
                first = sub.firstByte // 2 if hasattr(sub, "firstByte") else sub.firstIndex
                tris = index[first:first + sub.indexCount].reshape(-1, 3)
                into.setdefault(mat, []).append((pos, nrm, uv, tris))
        for ch in t.m_Children:
            walk(ch.read(), world, decal)

    walk(component(root, 4), np.eye(4))
    return parts


def merged(chunks):
    pos, nrm, uv, tris, offset = [], [], [], [], 0
    for p, n, u, t in chunks:
        used = np.unique(t)
        remap = np.full(len(p), -1)
        remap[used] = np.arange(len(used)) + offset
        pos.append(p[used]); nrm.append(n[used])
        uv.append(u[used] if u is not None else np.zeros((len(used), 2)))
        tris.append(remap[t])
        offset += len(used)
    return np.concatenate(pos), np.concatenate(nrm), np.concatenate(uv), np.concatenate(tris)


# ---------------------------------------------------------------------------------------------
# glTF (binary): Unity is left-handed, glTF right-handed, so z flips and triangles reverse; glTF
# UVs start at the top.

def write_glb(path, parts):
    buf = bytearray()
    views, accessors, meshes, nodes, materials = [], [], [], [], []

    def add(data, target, comp, kind, minmax=False):
        while len(buf) % 4:
            buf.append(0)
        views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": data.nbytes, "target": target})
        buf.extend(data.tobytes())
        acc = {"bufferView": len(views) - 1, "componentType": comp, "count": len(data), "type": kind}
        if minmax:
            acc["min"] = data.min(axis=0).tolist()
            acc["max"] = data.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    for mat, chunks in parts.items():
        pos, nrm, uv, tris = merged(chunks)
        flip = np.array([1, 1, -1])
        attrs = {
            "POSITION": add((pos * flip).astype(np.float32), 34962, 5126, "VEC3", True),
            "NORMAL": add((nrm * flip).astype(np.float32), 34962, 5126, "VEC3"),
        }
        if mat == LIVERY_MATERIAL or SPONSOR_MATERIAL.match(mat):
            attrs["TEXCOORD_0"] = add(np.stack([uv[:, 0], 1 - uv[:, 1]], axis=1).astype(np.float32), 34962, 5126, "VEC2")
        idx = add(tris[:, ::-1].reshape(-1).astype(np.uint32), 34963, 5125, "SCALAR")
        colour = PART_COLOURS.get(mat, (0.2, 0.2, 0.2))
        materials.append({"name": mat, "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1] if mat == LIVERY_MATERIAL else [*colour, 1],
            "metallicFactor": 0.1 if mat == LIVERY_MATERIAL else 0.3, "roughnessFactor": 0.45 if mat == LIVERY_MATERIAL else 0.6}})
        meshes.append({"name": mat, "primitives": [{"attributes": attrs, "indices": idx, "material": len(materials) - 1}]})
        nodes.append({"name": mat, "mesh": len(meshes) - 1})

    while len(buf) % 4:
        buf.append(0)
    doc = {"asset": {"version": "2.0", "generator": "tools/ff20-car-renders.py"}, "scene": 0,
           "scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes, "meshes": meshes, "materials": materials,
           "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(buf)}]}
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(buf), 0x004E4942) + bytes(buf))


# ---------------------------------------------------------------------------------------------
# Side view: an orthographic render from the car's right side (nose to the right), keeping per
# pixel the material, the body UV and a light value.

def side_lookup(parts):
    w, h = RENDER
    allpos = np.concatenate([p for chunks in parts.values() for p, _, _, _ in chunks])
    zmin, zmax = allpos[:, 2].min(), allpos[:, 2].max()
    ymin, ymax = allpos[:, 1].min(), allpos[:, 1].max()
    scale = min((w * 0.96) / (zmax - zmin), (h * 0.92) / (ymax - ymin))
    ox = (w - (zmax - zmin) * scale) / 2
    oy = (h - (ymax - ymin) * scale) / 2

    depth = np.full((h, w), -np.inf)
    mat_id = np.full((h, w), -1, dtype=np.int32)
    uvs = np.zeros((h, w, 2))
    light = np.zeros((h, w))
    names = list(parts)
    sun = np.array([0.45, 0.75, 0.35])
    sun /= np.linalg.norm(sun)

    for mi, mat in enumerate(names):
        for pos, nrm, uv, tris in parts[mat]:
            # Screen: x from z (nose = +z to the right), y from y (up), depth = x (viewer at +x).
            sx = ox + (pos[:, 2] - zmin) * scale
            sy = h - (oy + (pos[:, 1] - ymin) * scale)
            sz = pos[:, 0]
            for a, b, c in tris:
                xs, ys = sx[[a, b, c]], sy[[a, b, c]]
                x0, x1 = max(int(np.floor(xs.min())), 0), min(int(np.ceil(xs.max())), w - 1)
                y0, y1 = max(int(np.floor(ys.min())), 0), min(int(np.ceil(ys.max())), h - 1)
                if x0 > x1 or y0 > y1:
                    continue
                den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
                if abs(den) < 1e-12:
                    continue
                gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
                l0 = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / den
                l1 = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / den
                l2 = 1 - l0 - l1
                inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
                if not inside.any():
                    continue
                z = l0 * sz[a] + l1 * sz[b] + l2 * sz[c]
                region = depth[y0:y1 + 1, x0:x1 + 1]
                win = inside & (z > region)
                if not win.any():
                    continue
                region[win] = z[win]
                mat_id[y0:y1 + 1, x0:x1 + 1][win] = mi
                n = l0[..., None] * nrm[a] + l1[..., None] * nrm[b] + l2[..., None] * nrm[c]
                n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)
                light[y0:y1 + 1, x0:x1 + 1][win] = 0.5 + 0.5 * np.clip(n[win] @ sun, 0, 1)
                if uv is not None and mat == LIVERY_MATERIAL:
                    u = l0 * uv[a, 0] + l1 * uv[b, 0] + l2 * uv[c, 0]
                    v = l0 * uv[a, 1] + l1 * uv[b, 1] + l2 * uv[c, 1]
                    uvs[y0:y1 + 1, x0:x1 + 1][win] = np.stack([u[win], v[win]], axis=-1)
    return names, mat_id, uvs, light


def overlay_image(names, mat_id, light):
    h, w = mat_id.shape
    out = np.zeros((h, w, 4))
    body = names.index(LIVERY_MATERIAL) if LIVERY_MATERIAL in names else -2
    for mi, mat in enumerate(names):
        sel = mat_id == mi
        if mi == body:
            out[sel, 3] = 1 - light[sel]          # black over the tinted body: its shading
        else:
            out[sel, :3] = np.array(PART_COLOURS.get(mat, (0.2, 0.2, 0.2)))[None, :] * light[sel][:, None]
            out[sel, 3] = 1
    img = Image.fromarray((out * 255).round().astype(np.uint8), "RGBA")
    return img.resize(MASK, Image.LANCZOS)


def key_texture(base, detail):
    """Base + detail colour key, as FF20's shader adds them, at UV_SIZE."""
    b = np.asarray(base.convert("RGB").resize((UV_SIZE, UV_SIZE), Image.LANCZOS), dtype=np.float32)
    if detail is not None:
        b = b + np.asarray(detail.convert("RGB").resize((UV_SIZE, UV_SIZE), Image.BILINEAR), dtype=np.float32)
    return Image.fromarray(np.clip(b, 0, 255).astype(np.uint8), "RGB")


def side_mask(key, names, mat_id, uvs):
    h, w = mat_id.shape
    body = mat_id == names.index(LIVERY_MATERIAL)
    k = np.asarray(key)
    # UnityPy images are top-down; UV v runs bottom-up.
    px = np.clip((uvs[..., 0] % 1.0) * UV_SIZE, 0, UV_SIZE - 1).astype(int)
    py = np.clip((1 - (uvs[..., 1] % 1.0)) * UV_SIZE, 0, UV_SIZE - 1).astype(int)
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[body, :3] = k[py[body], px[body]]
    out[body, 3] = 255
    return Image.fromarray(out, "RGBA").resize(MASK, Image.LANCZOS)


# ---------------------------------------------------------------------------------------------
# Livery textures

def resource_paths(data_dir):
    env = UnityPy.load(os.path.join(data_dir, "globalgamemanagers"))
    rm = next(o for o in env.objects if o.type.name == "ResourceManager").read_typetree()
    return {name: ptr["m_PathID"] for name, ptr in rm["m_Container"]
            if name.startswith(PREFIX) and ptr["m_FileID"] == 2}


def livery_textures(data_dir):
    """(base, detail) texture-name pairs in MM's Liveries table and FF20's liverypack, and a lookup
    from texture name to a PIL image loader."""
    resources = UnityPy.load(os.path.join(data_dir, "resources.assets"))
    objects = {o.path_id: o for o in resources.objects}
    paths = resource_paths(data_dir)
    loaders = {}
    for name, pid in paths.items():
        loaders[name[len(PREFIX):].lower()] = (lambda o=objects[pid]: o.read().image)
    dlc = os.path.join(data_dir, "StreamingAssets", "AssetBundles", "livery_pack_dlc")
    if os.path.exists(dlc):
        for name, obj in UnityPy.load(dlc).container.items():
            if name.startswith(DLC_PREFIX) and name.endswith(".psd"):
                loaders[name[len(DLC_PREFIX):-len(".psd")].lower()] = (lambda o=obj: o.read().image)
    pack = os.path.join(data_dir, "Modding", "Images", "liverypack")
    if os.path.exists(pack):
        for o in UnityPy.load(pack).objects:
            if o.type.name == "Texture2D" and re.fullmatch(r"Livery(Base|Detail)_\d+", o.peek_name()):
                loaders[o.peek_name().lower()] = (lambda o=o: o.read().image)

    table = next(o for o in resources.objects if o.type.name == "TextAsset" and o.peek_name() == "Liveries").read().m_Script
    table = table if isinstance(table, str) else table.decode("utf-8", "replace")
    pairs = set()
    for r in csv.DictReader(io.StringIO(table.replace("\r", ""))):
        if r.get("ID") and r.get("Chassis Base Texture"):
            pairs.add((r["Chassis Base Texture"], r["Chassis Detail Texture"]))
    for name in loaders:
        m = re.fullmatch(r"liverybase_(\d+)", name)
        if m:
            pairs.add((f"LiveryBase_{m.group(1)}", f"LiveryDetail_{m.group(1)}"))
        # The Livery Pack DLC's liveries aren't in the table; each folder has a base and a detail
        # texture, used either way round.
        m = re.fullmatch(r"(dlc/.+)/liverybase", name)
        if m and f"{m.group(1)}/liverydetail" in loaders:
            pairs.add((f"{m.group(1)}/liverybase", f"{m.group(1)}/liverydetail"))
            pairs.add((f"{m.group(1)}/liverydetail", f"{m.group(1)}/liverybase"))
    return sorted(pairs), loaders


def main(argv):
    if len(argv) not in (3, 4):
        sys.exit(__doc__)
    data_dir, out = argv[1], argv[2]
    model = argv[3] if len(argv) == 4 else "F1"
    os.makedirs(out, exist_ok=True)
    tag = f"ff20-{slug(model)}"

    sponsors = {}
    parts = car_parts(os.path.join(data_dir, "Modding", "Models", "Vehicle", model), sponsors)
    if LIVERY_MATERIAL not in parts:
        sys.exit(f"No '{LIVERY_MATERIAL}' material in the {model} model")
    decals = {m: c for m, c in sponsors.items() if SPONSOR_MATERIAL.match(m)}
    write_glb(os.path.join(out, f"{tag}-car.glb"), {**parts, **decals})
    names, mat_id, uvs, light = side_lookup(parts)
    overlay_image(names, mat_id, light).save(os.path.join(out, f"{tag}-overlay.png"), optimize=True)

    pairs, loaders = livery_textures(data_dir)
    done = missing = 0
    for base, detail in pairs:
        load_base = loaders.get(base.lower())
        if not load_base:
            missing += 1
            continue
        load_detail = loaders.get(detail.lower())
        key = key_texture(load_base(), load_detail() if load_detail else None)
        k = livery_key(base, detail)
        uv_file = os.path.join(out, f"ff20-uv-{k}.png")
        if not os.path.exists(uv_file):
            key.save(uv_file, optimize=True)
        side_mask(key, names, mat_id, uvs).save(os.path.join(out, f"{tag}-{k}.png"), optimize=True)
        done += 1
    print(f"Wrote the {model} car, its overlay and {done} liveries to {out}" + (f" ({missing} without a texture)" if missing else ""))


if __name__ == "__main__":
    main(sys.argv)
