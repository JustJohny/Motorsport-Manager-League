"""Add or replace supplier logos in MM's supplierlogos mod bundle (MM_Data/Modding/Images/supplierlogos).

    python supplier-logos.py <source bundle> <output bundle> Supplier_Fuel_9=orlen.png [...]

Textures are named Supplier_<Type>_<logo ID - 1> (AssetManager.GetSupplierLogo) and are 184 x 64 like
the bundle's own; each logo is scaled to fit, centred on transparent, and stored as ARGB32.
"""
import copy
import os
import sys

import UnityPy
from PIL import Image

ARGB32 = 5
W, H = 184, 64


def fit(path):
    img = Image.open(path).convert("RGBA")
    img.thumbnail((W, H), Image.LANCZOS)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas.paste(img, ((W - img.width) // 2, (H - img.height) // 2), img)
    return canvas


def argb32(img):
    """Unity stores rows bottom-up; ARGB32 is A, R, G, B per pixel."""
    r, g, b, a = img.transpose(Image.FLIP_TOP_BOTTOM).split()
    return Image.merge("RGBA", (a, r, g, b)).tobytes()


def main(argv):
    if len(argv) < 4:
        sys.exit(__doc__)
    src, dst, pairs = argv[1], argv[2], [p.split("=", 1) for p in argv[3:]]
    if os.path.abspath(src) == os.path.abspath(dst):
        sys.exit("The output must not overwrite the input bundle")
    env = UnityPy.load(src)
    sf = next(o for o in env.objects if o.type.name == "AssetBundle").assets_file
    bundle = next(o for o in sf.objects.values() if o.type.name == "AssetBundle")
    textures = {o.peek_name(): o for o in sf.objects.values() if o.type.name == "Texture2D"}
    template = next(iter(textures.values()))
    ab = bundle.read_typetree()
    next_id = max(sf.objects) + 1
    for name, path in pairs:
        data = argb32(fit(path))
        obj = textures.get(name)
        if obj is None:
            obj = copy.copy(template)
            obj.path_id = next_id
            next_id += 1
            obj.set_raw_data(template.get_raw_data())
            sf.objects[obj.path_id] = obj
            pptr = {"m_FileID": 0, "m_PathID": obj.path_id}
            ab["m_PreloadTable"].append(pptr)
            ab["m_Container"].append((f"assets/{name.lower()}.png", {
                "preloadIndex": len(ab["m_PreloadTable"]) - 1, "preloadSize": 1, "asset": dict(pptr)}))
            action = "added"
        else:
            action = "replaced"
        tex = obj.read_typetree()
        tex.update({"m_Name": name, "m_Width": W, "m_Height": H, "m_TextureFormat": ARGB32, "m_MipCount": 1,
                    "m_ImageCount": 1, "m_CompleteImageSize": len(data), "image data": data,
                    "m_StreamData": {"offset": 0, "size": 0, "path": ""}})
        obj.save_typetree(tex)
        print(f"{name} {action}")
    ab["m_Container"].sort(key=lambda c: c[0])
    bundle.save_typetree(ab)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(env.file.save(packer="lz4"))
    print(f"Wrote {dst}")


if __name__ == "__main__":
    main(sys.argv)
