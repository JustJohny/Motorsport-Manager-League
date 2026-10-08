#!/usr/bin/env python3
"""Build MM's portrait mod bundle (MM_Data/Modding/Images/portraits) from PNG files.

MM's portrait widget (UICharacterPortrait.TryLoadCustomPortrait) asks the mod system for a texture
named "<PersonType>_<index>": e.g. "Driver_0" for the first driver in the save's driverManager
(AssetManager.GetPortraitForPerson, Person.GetPersonIndexInManager). MM never removes people from
that list (retired ones stay, new ones are appended), so an index keeps meaning the same person.
See docs/save-schema.md, "Driver portraits".

A mod has one Unity 5.3.6 asset bundle per image type, named by file. There's no portrait bundle to
start from, so this takes any existing image mod bundle (e.g. Images/teamlogos) as a template: it
keeps the bundle's structure, drops its textures, renames it "portraits" and adds one uncompressed
ARGB32 texture per portrait.

  tools/portraits.py <template bundle> <out bundle> <Name>=<image.png> [...]
  e.g. tools/portraits.py teamlogos out/portraits Driver_0=hamilton.png

Images are fitted into SIZE x SIZE on transparent, keeping their aspect. Needs UnityPy.
"""
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mod_bundle import image_fields, write_bundle  # noqa: E402

SIZE = 256
BUNDLE = "portraits"


def fit(img, size):
    img = img.convert("RGBA")
    img.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - img.width) // 2, size - img.height), img)  # bottom-aligned: shoulders at the frame's edge
    return canvas


def main(argv):
    if len(argv) < 4:
        sys.exit(__doc__)
    src, dst, pairs = argv[1], argv[2], argv[3:]
    textures = {}
    for p in pairs:
        name, path = p.split("=", 1)
        textures[name] = image_fields(fit(Image.open(path), SIZE))
    try:
        write_bundle(src, dst, BUNDLE, textures)
    except ValueError as e:
        sys.exit(str(e))
    print(f"Wrote {dst}: {len(textures)} portraits")


if __name__ == "__main__":
    main(sys.argv)
