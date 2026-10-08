#!/usr/bin/env python3
"""Port Enzoli's "MM 2016 Mod" (1.3.2, Feb 2017) into MM 1.53's staging mod.

That mod is a whole replacement MM_Data/resources.assets built for MM 1.2 (Unity 5.3.6p8). It can't
be installed on 1.53: it lacks the Endurance series, challenges and newer fonts, and its streamed
textures point into the old game's resources.assets.resS. Its database tables are MM's own; the
2016 content is the textures it embeds:

  - livery patterns (colour keys) for 10 WMC and 2 GP2 liveries, e.g. the Red Bull bull and the
    Williams stripes -> Images/liveries, LiveryBase_<id-7> / LiveryDetail_<id-7>
    (AssetManager.GetLiveryTexture: the side-projected texture is "LiveryBase", the top one
    "LiveryDetail"; a livery needs both, so the unchanged one comes from 1.53)
  - 63 real sponsor decals (SponsorLogo<n>) -> Images/sponsorlogos, SponsorCar_<n-1> (the car) and
    Sponsor_<n-1> (the UI, scaled down), keyed by the sponsor's logo index

Enzoli's textures are named like 1.53's ("LiveryBase"), so which livery each one is comes from
object order: both games' resources.assets list shared assets in the same path ID order, so a
modded texture sits between the same uniquely named neighbours in both files.

Two things 1.53's mod system can't replace are written for the league game patch
(tools/league-patch, `mmsave game-patch`), which loads them at start-up:

  - the real track pictures of the calendar and event screens (sprites TrackImages-<circuit>, cut
    from the mod's embedded TrackImages atlas) -> league-sprites/TrackImages/<sprite>.png
  - its renames in MM's text tables: circuits (Guildford -> Silverstone ...), series and the
    governing body (GMA -> FIA) -> league-text.txt. Only names: the mod's other text changes are
    MM 1.2 wording that 1.53 rewrote.

Copy both into MM_Data.

The optional track movies ("MM TrackMovies for Enzoli's Mod") are Bink 1 files named .bk2; the
mod system loads Bink 1 as Videos/TrackMovies/<circuit>.bik (BasicMod.LoadVideosInfo), so the
game's own StreamingAssets stay untouched.

  tools/enzoli-port.py <Enzoli resources.assets> <MM_Data> <template bundle> <out folder>
                       [--movies <TrackMovies folder>]

The template is any existing image mod bundle (e.g. MM_Data/Modding/Images/teamlogos); see
tools/mod_bundle.py. Writes <out>/Images/liveries, Images/sponsorlogos, Videos/TrackMovies,
league-sprites/, league-text.txt and enzoli-port.json (what was ported). Needs UnityPy.
"""
import argparse
import bisect
import csv
import io
import json
import os
import re
import shutil
import sys

import UnityPy
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mod_bundle import image_fields, texture_fields, write_bundle  # noqa: E402

LIVERY_PREFIX = "carcustomisation/liverytextures/"
LIVERY_ID_OFFSET = 7          # ModImageFileInfo.liveryIdOffset
UI_SPONSOR_SIZE = (256, 128)
NAMED = {"Texture2D", "TextAsset", "Material", "Mesh", "Sprite", "Font", "AudioClip", "MovieTexture",
         "Shader", "AnimationClip", "GameObject"}


def named_objects(env):
    """(type, name) -> [path IDs], for object types that carry a name."""
    out = {}
    for o in env.objects:
        if o.type.name not in NAMED:
            continue
        try:
            name = o.peek_name()
        except Exception:
            continue
        out.setdefault((o.type.name, name), []).append(o.path_id)
    return out


def is_inline(obj):
    tree = obj.read_typetree()
    return not (tree.get("m_StreamData") or {}).get("size")


def match_by_order(old, new, names, new_ok, wanted):
    """Old path ID -> new path ID for objects with the given (type, name)s, using uniquely named
    objects present in both files as anchors. new_ok filters new candidates (e.g. drops assets
    that didn't exist in the old game). Only groups holding a `wanted` old object must match."""
    anchors = sorted((old[k][0], new[k][0]) for k in old if k in new and len(old[k]) == 1 and len(new[k]) == 1)
    old_ids = [a[0] for a in anchors]

    def gap(pid):
        i = bisect.bisect_left(old_ids, pid)
        return (anchors[i - 1][1] if i else -1), (anchors[i][1] if i < len(anchors) else 1 << 62)

    result = {}
    for key in names:
        groups = {}
        for pid in old.get(key, []):
            groups.setdefault(gap(pid), []).append(pid)
        for (lo, hi), olds in groups.items():
            cands = sorted(p for p in new.get(key, []) if lo < p < hi and new_ok(p))
            if len(cands) != len(olds):
                if not any(wanted(o) for o in olds):
                    continue
                raise SystemExit(f"Can't match {key[1]} {olds}: 1.53 has {cands} between the same neighbours")
            result.update(zip(sorted(olds), cands))
    return result


def livery_rows(objs_new):
    """MM 1.53's Liveries table: id -> (base path, base projection, detail path, detail projection)."""
    text = next(o for o in objs_new.values() if o.type.name == "TextAsset" and o.peek_name() == "Liveries").read().m_Script
    rows = {}
    for r in csv.DictReader(io.StringIO(text.replace("\r", ""))):
        if not r.get("ID") or r.get("DLC ID", "0") not in ("", "0"):
            continue
        rows[int(r["ID"])] = (r["Chassis Base Texture"].lower(), r["Chassis Base Projection"],
                              r["Chassis Detail Texture"].lower(), r["Chassis Detail Projection"])
    return rows


# Renames Enzoli made with whole-text rules too, besides his Shared table.
TEXT_RENAMES = {"GMA": "FIA", "Global Motorsport Association": "Fédération Internationale de l'Automobile",
                # MM 1.53 still calls the Tondela circuit "Madrid" in media texts (its sprite name too).
                "Madrid": "Barcelona"}


def text_table(env, name):
    """English text by ID of one of MM's localisation tables."""
    o = next(o for o in env.objects if o.type.name == "TextAsset" and o.peek_name() == name)
    out = {}
    for r in csv.DictReader(io.StringIO(o.read().m_Script)):
        if r.get("ID"):
            out[r["ID"]] = r.get("English", "")
    return out


def text_rules(env_old, env_new):
    """league-text.txt lines from the names the mod changed in MM's Shared table."""
    old, new = text_table(env_old, "Shared"), text_table(env_new, "Shared")
    ids, renames = [], dict(TEXT_RENAMES)
    for i, text in old.items():
        was = new.get(i)
        if not was or was.strip().lower() == text.strip().lower():
            continue
        ids.append(f"{i}={text}")
        strip = lambda t: re.sub(r"^(the|The) ", "", t.strip())
        renames[strip(was)] = strip(text)
    lines = ["# Enzoli's MM 2016 Mod renames (tools/enzoli-port.py), read by the league game patch.",
             "# ID=text sets that text in every language; ~Old=New renames a whole word or phrase everywhere."]
    lines += sorted(ids) + [f"~{k}={v}" for k, v in sorted(renames.items())]
    return lines


def track_images(env_old, out):
    """TrackImages-<circuit> sprites, cut from the mod's embedded atlas; returns their names."""
    objs = {o.path_id: o for o in env_old.objects}
    atlases, names = {}, []
    os.makedirs(out, exist_ok=True)
    for o in objs.values():
        if o.type.name != "Sprite" or not o.peek_name().startswith("TrackImages-"):
            continue
        t = o.read_typetree()
        tex = objs[t["m_RD"]["texture"]["m_PathID"]]
        if not is_inline(tex):
            continue
        if tex.path_id not in atlases:
            atlases[tex.path_id] = tex.read().image
        atlas, r = atlases[tex.path_id], t["m_RD"]["textureRect"]
        # Unity rects start bottom-left.
        box = (r["x"], atlas.height - r["y"] - r["height"], r["x"] + r["width"], atlas.height - r["y"])
        atlas.crop(tuple(round(v) for v in box)).save(os.path.join(out, t["m_Name"] + ".png"))
        names.append(t["m_Name"])
    return sorted(names)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("enzoli")
    p.add_argument("data_dir")
    p.add_argument("template")
    p.add_argument("out")
    p.add_argument("--movies")
    a = p.parse_args()

    env_old = UnityPy.load(a.enzoli)
    env_new = UnityPy.load(os.path.join(a.data_dir, "resources.assets"))
    res_s = os.path.join(a.data_dir, "resources.assets.resS")
    objs_old = {o.path_id: o for o in env_old.objects}
    objs_new = {o.path_id: o for o in env_new.objects}
    gm = UnityPy.load(os.path.join(a.data_dir, "globalgamemanagers"))
    rm = next(o for o in gm.objects if o.type.name == "ResourceManager").read_typetree()
    paths = {ptr["m_PathID"]: name for name, ptr in rm["m_Container"] if ptr["m_FileID"] == 2}
    by_path = {v: k for k, v in paths.items()}
    report = {"liveries": [], "sponsors": [], "movies": [], "sprites": [], "text": []}

    # Liveries.
    old_named, new_named = named_objects(env_old), named_objects(env_new)
    keys = [("Texture2D", "LiveryBase"), ("Texture2D", "LiveryDetail")]
    # Endurance liveries came after Enzoli's game version.
    mapping = match_by_order(old_named, new_named, keys,
                             lambda pid: paths.get(pid, "").startswith(LIVERY_PREFIX) and "/endurance/" not in paths[pid],
                             lambda pid: is_inline(objs_old[pid]))
    modded = {}  # 1.53 resource path (without prefix) -> Enzoli object
    for old_pid, new_pid in mapping.items():
        if is_inline(objs_old[old_pid]):
            modded[paths[new_pid][len(LIVERY_PREFIX):]] = objs_old[old_pid]

    def fields_for(rel):
        if rel in modded:
            return texture_fields(modded[rel].read_typetree())
        return texture_fields(objs_new[by_path[LIVERY_PREFIX + rel]].read_typetree(), res_s)

    textures = {}
    for lid, (base, base_proj, detail, detail_proj) in sorted(livery_rows(objs_new).items()):
        if base not in modded and detail not in modded:
            continue
        n = lid - LIVERY_ID_OFFSET
        # The side-projected texture is "LiveryBase", the other "LiveryDetail", whichever slot it's in.
        for rel, proj in ((base, base_proj), (detail, detail_proj)):
            textures[f"{'LiveryBase' if proj == 'Side' else 'LiveryDetail'}_{n}"] = fields_for(rel)
        report["liveries"].append({"id": lid, "base": base, "detail": detail,
                                   "changed": [t for t in (base, detail) if t in modded]})
    unused = set(modded) - {t for r in report["liveries"] for t in r["changed"]}
    if unused:
        print(f"Note: no 1.53 livery uses {sorted(unused)}")
    write_bundle(a.template, os.path.join(a.out, "Images", "liveries"), "liveries", textures)
    print(f"Images/liveries: {len(report['liveries'])} liveries ({', '.join(str(r['id']) for r in report['liveries'])})")

    # Sponsor decals: every SponsorLogo<n> the mod embeds (MM's own are streamed).
    textures = {}
    for o in env_old.objects:
        if o.type.name != "Texture2D":
            continue
        m = re.fullmatch(r"SponsorLogo(\d+)", o.peek_name())
        if not m or not is_inline(o):
            continue
        n = int(m.group(1))
        textures[f"SponsorCar_{n - 1}"] = texture_fields(o.read_typetree())
        ui = o.read().image.convert("RGBA")
        ui.thumbnail(UI_SPONSOR_SIZE, Image.LANCZOS)
        textures[f"Sponsor_{n - 1}"] = image_fields(ui)
        report["sponsors"].append(n)
    report["sponsors"].sort()
    write_bundle(a.template, os.path.join(a.out, "Images", "sponsorlogos"), "sponsorlogos", textures)
    print(f"Images/sponsorlogos: {len(report['sponsors'])} sponsor logos")

    # For the league game patch: track pictures and text renames.
    report["sprites"] = track_images(env_old, os.path.join(a.out, "league-sprites", "TrackImages"))
    print(f"league-sprites/TrackImages: {len(report['sprites'])} track pictures")
    report["text"] = text_rules(env_old, env_new)
    with open(os.path.join(a.out, "league-text.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(report["text"]) + "\n")
    print(f"league-text.txt: {sum(1 for l in report['text'] if not l.startswith('#'))} rules")

    if a.movies:
        dst = os.path.join(a.out, "Videos", "TrackMovies")
        os.makedirs(dst, exist_ok=True)
        for f in sorted(os.listdir(a.movies)):
            stem, ext = os.path.splitext(f)
            if ext.lower() not in (".bk2", ".bik"):
                continue
            with open(os.path.join(a.movies, f), "rb") as fh:
                if fh.read(3) != b"BIK":
                    print(f"Skipped {f}: not a Bink 1 file (the mod system plays .bik)")
                    continue
            shutil.copyfile(os.path.join(a.movies, f), os.path.join(dst, stem + ".bik"))
            report["movies"].append(stem)
        print(f"Videos/TrackMovies: {len(report['movies'])} track movies")

    with open(os.path.join(a.out, "enzoli-port.json"), "w") as f:
        json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
