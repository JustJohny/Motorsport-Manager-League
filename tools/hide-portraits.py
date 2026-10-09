#!/usr/bin/env python3
"""Take portraits out of a mod's portrait bundle (MM_Data/Modding/Images/portraits), so MM draws
those people's faces itself.

MM looks a mod portrait up by texture name ("<PersonType>_<index>", AssetManager.GetPortraitForPerson)
and keys every texture of the bundle by name (ModFileInfo.CacheAssets, which throws on a duplicate).
Renaming a texture to "Hidden_<name>" therefore removes it without touching the bundle's structure.

  tools/hide-portraits.py <bundle> <out bundle> <Name> [...]
  e.g. tools/hide-portraits.py portraits.orig portraits TeamPrincipal_5 TeamPrincipal_8

Needs UnityPy.
"""
import sys

import UnityPy

PREFIX = "Hidden_"


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    src, dst, names = argv[1], argv[2], set(argv[3:])
    env = UnityPy.load(src)
    hidden = []
    for obj in env.objects:
        if obj.type.name != "Texture2D":
            continue
        tree = obj.read_typetree()
        if tree["m_Name"] in names:
            hidden.append(tree["m_Name"])
            tree["m_Name"] = PREFIX + tree["m_Name"]
            obj.save_typetree(tree)
    missing = names - set(hidden)
    if missing:
        print(f"Not in the bundle (MM already draws these): {', '.join(sorted(missing))}")
    with open(dst, "wb") as f:
        f.write(env.file.save(packer="lz4"))
    print(f"Wrote {dst}: {len(hidden)} portraits hidden")


if __name__ == "__main__":
    main(sys.argv)
