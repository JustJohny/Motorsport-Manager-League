#!/usr/bin/env python3
"""Export MM's livery colour masks for the site's livery previews.

Every livery texture is a colour key: black = primary, red = secondary, green = tertiary,
blue = trim (MM's shader blends the team's colours by channel). The side-view texture's lower
half is the car's flank; that strip, scaled to 512x128, is what the site tints with a member's
colours. Upper halves hold MM's colour legend and empty space.

Textures come from MM_Data/resources.assets (paths from the ResourceManager in
globalgamemanagers, under carcustomisation/liverytextures/) and the Livery Pack DLC bundle
(StreamingAssets/AssetBundles/livery_pack_dlc). Files are named after the livery data's texture
path, lowercased, "/" -> "-" (src/ops/team.ts, liveryMask): "gp1-livery5-liverybase.png".

These are game assets: they go to the site's storage bucket (`mmsave liveries`), not the repo.

  tools/livery-masks.py <MM_Data folder> <out folder>

Needs UnityPy (pip install UnityPy).
"""
import os
import sys

import UnityPy
from PIL import Image

PREFIX = "carcustomisation/liverytextures/"
DLC_PREFIX = "assets/editor/assetbundleresources/livery_pack_dlc/"
SIZE = (512, 128)


def resource_paths(data_dir):
    """Resource path -> path ID in resources.assets (file index 2 in globalgamemanagers)."""
    env = UnityPy.load(os.path.join(data_dir, "globalgamemanagers"))
    rm = next(o for o in env.objects if o.type.name == "ResourceManager").read_typetree()
    return {name: ptr["m_PathID"] for name, ptr in rm["m_Container"]
            if name.startswith(PREFIX) and ptr["m_FileID"] == 2}


def flank(img):
    w, h = img.size
    return img.convert("RGB").crop((0, h // 2, w, h)).resize(SIZE, Image.LANCZOS)


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__)
    data_dir, out = argv[1], argv[2]
    os.makedirs(out, exist_ok=True)
    count = 0

    paths = resource_paths(data_dir)
    objects = {o.path_id: o for o in UnityPy.load(os.path.join(data_dir, "resources.assets")).objects}
    for name, path_id in sorted(paths.items()):
        rel = name[len(PREFIX):]
        flank(objects[path_id].read().image).save(os.path.join(out, rel.replace("/", "-") + ".png"), optimize=True)
        count += 1

    dlc = os.path.join(data_dir, "StreamingAssets", "AssetBundles", "livery_pack_dlc")
    if os.path.exists(dlc):
        env = UnityPy.load(dlc)
        for name, obj in sorted(env.container.items()):
            if not name.startswith(DLC_PREFIX) or not name.endswith(".psd"):
                continue
            rel = name[len(DLC_PREFIX):-len(".psd")]
            flank(obj.read().image).save(os.path.join(out, rel.replace("/", "-") + ".png"), optimize=True)
            count += 1
    print(f"Wrote {count} masks to {out}")


if __name__ == "__main__":
    main(sys.argv)
