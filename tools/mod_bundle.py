"""Write an MM image mod bundle (MM_Data/Modding/Images/<type>) holding the given textures.

MM loads every asset of an image mod bundle and looks textures up by name (ModFileInfo.CacheAssets),
e.g. "Driver_0" in Images/portraits or "LiveryBase_4" in Images/liveries. A mod has one Unity 5.3.6
asset bundle per image type, named by file. There's no bundle of each type to start from, so this
takes any existing image mod bundle (e.g. Images/teamlogos) as a template: it keeps the bundle's
structure, drops its textures, renames it and adds one texture per entry.

Used by tools/portraits.py and tools/enzoli-port.py. Needs UnityPy.
"""
import copy
import hashlib
import os

import UnityPy
from PIL import Image

ARGB32 = 5


def argb32(img):
    """Unity stores rows bottom-up; ARGB32 is A, R, G, B per pixel."""
    r, g, b, a = img.convert("RGBA").transpose(Image.FLIP_TOP_BOTTOM).split()
    return Image.merge("RGBA", (a, r, g, b)).tobytes()


def image_fields(img):
    """Texture fields for an uncompressed ARGB32 texture without mipmaps."""
    data = argb32(img)
    return {"m_Width": img.width, "m_Height": img.height, "m_TextureFormat": ARGB32, "m_MipCount": 1,
            "m_ImageCount": 1, "m_CompleteImageSize": len(data), "image data": data}


def texture_fields(tree, res_s=None):
    """Texture fields copied from another Texture2D's type tree, keeping its format and mipmaps.
    Streamed pixel data (m_StreamData, Unity 5.3 .resS files) is read from res_s."""
    keep = ("m_Width", "m_Height", "m_CompleteImageSize", "m_TextureFormat", "m_MipCount", "m_ImageCount",
            "m_TextureDimension", "m_TextureSettings", "m_LightmapFormat", "m_ColorSpace")
    fields = {k: copy.deepcopy(tree[k]) for k in keep if k in tree}
    data = tree["image data"]
    stream = tree.get("m_StreamData") or {}
    if not data and stream.get("size"):
        if not res_s:
            raise ValueError(f"{tree['m_Name']} is streamed from {stream['path']}; pass its .resS file")
        with open(res_s, "rb") as f:
            f.seek(stream["offset"])
            data = f.read(stream["size"])
    fields["image data"] = bytes(data)
    return fields


def write_bundle(template_path, dst, bundle_name, textures):
    """textures: {texture name: fields from image_fields() or texture_fields()}."""
    if os.path.abspath(template_path) == os.path.abspath(dst):
        raise ValueError("The output must not overwrite the template bundle")
    if not textures:
        raise ValueError("No textures given")
    env = UnityPy.load(template_path)
    sf = next(o for o in env.objects if o.type.name == "AssetBundle").assets_file
    bundle = next(o for o in sf.objects.values() if o.type.name == "AssetBundle")
    existing = [o for o in sf.objects.values() if o.type.name == "Texture2D"]
    template = next(o for o in existing if o.read_typetree()["m_TextureFormat"] == ARGB32)
    template_raw = template.get_raw_data()

    # Drop the template's textures; keep everything else (bundle object, type tree).
    for o in existing:
        if o is not template:
            del sf.objects[o.path_id]
    ab = bundle.read_typetree()
    ab["m_PreloadTable"] = []
    ab["m_Container"] = []
    ab["m_Name"] = bundle_name
    ab["m_AssetBundleName"] = bundle_name

    next_id = max(sf.objects) + 1
    for i, (name, fields) in enumerate(sorted(textures.items())):
        if i == 0:
            obj = template
        else:
            obj = copy.copy(template)
            obj.path_id = next_id
            next_id += 1
            obj.set_raw_data(template_raw)
            sf.objects[obj.path_id] = obj
        tex = obj.read_typetree()
        tex.update(fields)
        tex.update({"m_Name": name, "m_StreamData": {"offset": 0, "size": 0, "path": ""}})
        obj.save_typetree(tex)
        pptr = {"m_FileID": 0, "m_PathID": obj.path_id}
        ab["m_PreloadTable"].append(pptr)
        ab["m_Container"].append((f"assets/{bundle_name}/{name.lower()}.png", {
            "preloadIndex": len(ab["m_PreloadTable"]) - 1, "preloadSize": 1, "asset": dict(pptr)}))
    ab["m_Container"].sort(key=lambda c: c[0])
    bundle.save_typetree(ab)

    # Unity won't load two bundles holding the same internal file at once: give it its own name.
    files = env.file.files
    for key in list(files):
        if key.startswith("CAB-"):
            new = "CAB-" + hashlib.md5(f"mm-league-{bundle_name}".encode()).hexdigest()
            files[new] = files.pop(key)
            if hasattr(files[new], "name"):
                files[new].name = new

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(env.file.save(packer="lz4"))
