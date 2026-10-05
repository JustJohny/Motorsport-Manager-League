#!/usr/bin/env python3
"""Add league team logos to MM's team logo mod bundle (MM_Data/Modding/Images/teamlogos).

MM draws an AI team's logo from a mod texture named <prefix>_<teamID>, else from its own atlas
(docs/save-schema.md, "Team colours, livery and logos"). A mod has one Unity 5.3.6 asset bundle
per image type, so member logos go into a copy of the existing bundle: each new texture is a
clone of one of its uncompressed ARGB32 textures, listed in the bundle's preload table and
container like the others. A texture that already exists for that team is replaced.

Needs UnityPy (pip install UnityPy), which brings Pillow.

  tools/team-logos.py <in bundle> <out bundle> <teamID>=<logo.png> [...]

The input bundle is only read; the output must be a different path.
"""
import copy
import os
import sys

import UnityPy
from PIL import Image

ARGB32 = 5
# Prefix: (width, height, greyscale). Sizes match the bundle's existing textures.
VARIANTS = {
    "Team": (307, 106, False),
    "TeamSmall": (184, 64, False),
    "TeamBW": (184, 64, True),
    "TeamHat": (61, 35, False),
    "TeamBody": (172, 72, False),
    "TeamChairmanBody": (172, 72, False),
}


def fit(logo, w, h, grey):
    """Scale to fit w x h, centred on transparent; BW is a greyscale copy like MM's own."""
    img = logo.convert("RGBA")
    img.thumbnail((w, h), Image.LANCZOS)
    if grey:
        alpha = img.getchannel("A")
        img = img.convert("L").convert("RGBA")
        img.putalpha(alpha)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(img, ((w - img.width) // 2, (h - img.height) // 2), img)
    return canvas


def argb32(img):
    """Unity stores rows bottom-up; ARGB32 is A, R, G, B per pixel."""
    r, g, b, a = img.transpose(Image.FLIP_TOP_BOTTOM).split()
    return Image.merge("RGBA", (a, r, g, b)).tobytes()


def main(argv):
    if len(argv) < 4:
        sys.exit(__doc__)
    src, dst, pairs = argv[1], argv[2], argv[3:]
    if os.path.abspath(src) == os.path.abspath(dst):
        sys.exit("The output must not overwrite the input bundle")
    logos = {}
    for p in pairs:
        team, path = p.split("=", 1)
        logos[int(team)] = Image.open(path)

    env = UnityPy.load(src)
    sf = next(o for o in env.objects if o.type.name == "AssetBundle").assets_file
    bundle = next(o for o in sf.objects.values() if o.type.name == "AssetBundle")
    textures = {o.peek_name(): o for o in sf.objects.values() if o.type.name == "Texture2D"}
    template = next(o for o in textures.values() if o.read_typetree()["m_TextureFormat"] == ARGB32)

    ab = bundle.read_typetree()
    next_id = max(sf.objects) + 1
    for team, logo in logos.items():
        for prefix, (w, h, grey) in VARIANTS.items():
            name = f"{prefix}_{team}"
            data = argb32(fit(logo, w, h, grey))
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
            tex.update({"m_Name": name, "m_Width": w, "m_Height": h, "m_TextureFormat": ARGB32, "m_MipCount": 1,
                        "m_ImageCount": 1, "m_CompleteImageSize": len(data), "image data": data,
                        "m_StreamData": {"offset": 0, "size": 0, "path": ""}})
            obj.save_typetree(tex)
            print(f"{name} {w}x{h} {action}")
    ab["m_Container"].sort(key=lambda c: c[0])
    bundle.save_typetree(ab)

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(env.file.save(packer="lz4"))
    print(f"Wrote {dst}")


if __name__ == "__main__":
    main(sys.argv)
