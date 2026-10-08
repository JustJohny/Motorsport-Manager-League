#!/usr/bin/env python3
"""Real drivers' photos as MM portraits, from Wikimedia Commons (free licences).

Stages (each caches its results in the work folder, so they can be rerun):

  resolve  drivers.json -> identity.json   Wikidata person per driver: name search, matched on the
                                           exact birth date (MM's invented people don't match and
                                           keep MM's drawn face). --overrides pins or skips one.
  fetch    -> candidates.json              photos from the person's Commons category for 2016, then
                                           2015 / 2017, then the nearest other years, the whole
                                           category and the Wikidata image (each with one level of
                                           subcategories); face detection (OpenCV YuNet) ranks them.
  preview  -> previews/                    every candidate's finished cut-out (slow: background removal).
  sheet    -> sheet.html                   contact sheet: the pick and alternatives per driver; your
                                           changes download as choices.json.
  facepack --facepack <bundle> -> facepack/, facepack.json
                                           an existing portrait mod (e.g. Enzoli's Facepack for 2016 Mod,
                                           Workshop 857892735) is numbered for another career, so each of
                                           its faces is matched to a driver by face recognition (OpenCV
                                           SFace) against that driver's photo candidates. A matched face is
                                           the driver's default pick on the sheet, ahead of the photos,
                                           and is used as made (its background kept).
  build    -> png/, CREDITS.md, Modding/Images/portraits
                                           head-and-shoulders crop around the face, background removed
                                           (rembg), 256x256, packed with tools/portraits.py.

  tools/driver-photos.py <stage> --work out/portraits [--drivers drivers.json] [--template teamlogos]

drivers.json comes from `mmsave drivers <save>`. Needs UnityPy, opencv-python-headless and
rembg[cpu] (tools/requirements.txt); the YuNet model is downloaded on first use.
"""
import argparse
import html
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "MMLeagueToolkit/0.1 (https://github.com/JustJohny/Motorsport-Manager-League)"}
YEARS = (2016, 2015, 2017)
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
SFACE_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx"
SAME_PERSON = 0.5      # SFace cosine similarity for a facepack match: OpenCV says 0.363, but below 0.5 small cut-outs mismatch
FACEPACK = "facepack:" # choice prefix for a facepack face
DETECT_WIDTH = 640     # thumbnails used for face detection
BUILD_WIDTH = 1600     # thumbnails used for the final crop
PER_CATEGORY = 24      # files looked at per category
SIZE = 256
HERE = os.path.dirname(os.path.abspath(__file__))


# ------------------------------------------------------------------------------------------------
# HTTP with a cache, politely slow (Wikimedia's API etiquette: a User-Agent, serial requests).

def fetch_bytes(url, cache_dir=None, retries=4):
    path = None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        key = re.sub(r"[^A-Za-z0-9._-]", "_", urllib.parse.unquote(url.split("/")[-1]))[-120:]
        path = os.path.join(cache_dir, key)
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                data = r.read()
            if path:
                with open(path, "wb") as f:
                    f.write(data)
            time.sleep(0.2)
            return data
        except Exception as e:  # noqa: BLE001 - network: retry, then give up on this file
            if getattr(e, "code", None) == 404:
                return None
            time.sleep(2 * (attempt + 1))
    return None


def api(base, **params):
    params.setdefault("format", "json")
    data = fetch_bytes(f"{base}?{urllib.parse.urlencode(params)}")
    return json.loads(data) if data else {}


def wikidata(**p):
    return api("https://www.wikidata.org/w/api.php", **p)


def commons(**p):
    return api("https://commons.wikimedia.org/w/api.php", **p)


def load(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf8") as f:
            return json.load(f)
    return default


def save(path, data):
    # Write then rename, so an interrupted run never leaves half a file.
    with open(path + ".tmp", "w", encoding="utf8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(path + ".tmp", path)


# ------------------------------------------------------------------------------------------------
# resolve

def claim_values(entity, prop):
    out = []
    for c in entity.get("claims", {}).get(prop, []):
        v = c.get("mainsnak", {}).get("datavalue", {}).get("value")
        if v is not None:
            out.append(v)
    return out


def birth_dates(entity):
    # "+1985-01-07T00:00:00Z" -> "1985-01-07"
    return {v["time"][1:11] for v in claim_values(entity, "P569") if isinstance(v, dict) and "time" in v}


def resolve(args):
    drivers = load(args.drivers, [])
    overrides = load(args.overrides, {}) if args.overrides else load(os.path.join(args.work, "overrides.json"), {})
    out = load(os.path.join(args.work, "identity.json"), {})
    for d in drivers:
        key = str(d["index"])
        o = overrides.get(key) or overrides.get(d["name"]) or {}
        if o.get("skip"):
            out[key] = {"name": d["name"], "qid": None, "why": "skipped (overrides.json)"}
            continue
        if key in out and out[key].get("name") == d["name"] and not o.get("qid"):
            continue
        found = None
        if o.get("qid"):
            found = o["qid"]
        else:
            seen = set()
            for query in (d["name"], f'{d["firstName"]} {d["lastName"]}', d["lastName"]):
                for hit in wikidata(action="wbsearchentities", search=query, language="en", type="item", limit=7).get("search", []):
                    if hit["id"] in seen:
                        continue
                    seen.add(hit["id"])
                    e = wikidata(action="wbgetentities", ids=hit["id"], props="claims").get("entities", {}).get(hit["id"], {})
                    if d["dateOfBirth"] in birth_dates(e):
                        found = hit["id"]
                        break
                if found:
                    break
        if not found:
            out[key] = {"name": d["name"], "qid": None, "why": "no Wikidata person with this name and birth date"}
            print(f'  {d["name"]}: not found', flush=True)
            continue
        e = wikidata(action="wbgetentities", ids=found, props="claims|sitelinks|labels", languages="en").get("entities", {}).get(found, {})
        category = (claim_values(e, "P373") or [None])[0]
        if not category:
            link = e.get("sitelinks", {}).get("commonswiki", {}).get("title", "")
            category = link[len("Category:"):] if link.startswith("Category:") else None
        out[key] = {
            "name": d["name"], "qid": found, "label": e.get("labels", {}).get("en", {}).get("value"),
            "category": category, "image": (claim_values(e, "P18") or [None])[0],
        }
        print(f'  {d["name"]}: {found} {category or "(no Commons category)"}', flush=True)
        save(os.path.join(args.work, "identity.json"), out)
    save(os.path.join(args.work, "identity.json"), out)
    ok = sum(1 for v in out.values() if v.get("qid"))
    print(f"resolved {ok} of {len(drivers)}")


# ------------------------------------------------------------------------------------------------
# fetch

_detector = None


def model_file(url):
    model = os.path.join(HERE, ".cache", url.rsplit("/", 1)[1])
    if not os.path.exists(model):
        os.makedirs(os.path.dirname(model), exist_ok=True)
        data = fetch_bytes(url)
        if not data:
            sys.exit(f"Couldn't download {url}")
        with open(model, "wb") as f:
            f.write(data)
    return model


def detector():
    global _detector
    if _detector is None:
        import cv2
        _detector = cv2.FaceDetectorYN.create(model_file(YUNET_URL), "", (320, 320), 0.8, 0.3, 50)
    return _detector


def faces(image_bytes):
    """[(x, y, w, h, score, landmarks)] in pixel units of the decoded image."""
    import cv2
    import numpy as np
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None, []
    h, w = img.shape[:2]
    det = detector()
    det.setInputSize((w, h))
    _, found = det.detect(img)
    return (w, h), [] if found is None else [tuple(f[:4]) + (float(f[14]), f[4:14]) for f in found]


def score_photo(size, found):
    """Big, frontal, alone in the frame, not cut off: higher is better. None if unusable."""
    if not found or not size:
        return None
    w, h = size
    found = sorted(found, key=lambda f: f[2] * f[3], reverse=True)
    x, y, fw, fh, conf, lm = found[0]
    rel = fw / w
    if rel < 0.06 or conf < 0.85:
        return None
    # Another face nearly as big: a group shot.
    if len(found) > 1 and found[1][2] > 0.6 * fw:
        return None
    # Frontal: the nose sits between the eyes.
    re_x, le_x, nose_x = lm[0], lm[2], lm[4]
    eye_span = abs(le_x - re_x) or 1
    frontal = 1 - min(1, abs(nose_x - (re_x + le_x) / 2) / (eye_span / 2))
    # Room for head and shoulders around the face.
    room = min(x, w - (x + fw), y) / fw
    fit = 1 if room > 0.4 else max(0.2, room / 0.4)
    return round(float((min(rel, 0.35) / 0.35) * 0.5 + frontal * 0.3 + conf * 0.1 + fit * 0.1), 4)


def category_members(category, kind):
    out, cont = [], {}
    while True:
        r = commons(action="query", list="categorymembers", cmtitle=f"Category:{category}", cmtype=kind,
                    cmlimit=200, **cont)
        out += [m["title"] for m in r.get("query", {}).get("categorymembers", [])]
        if "continue" not in r or len(out) >= 400:
            return out
        cont = r["continue"]


def category_files(category, limit):
    """Image files in a category and, while there's room, one level of its subcategories
    ("Lewis Hamilton in 2016" -> "Lewis Hamilton at the 2016 Malaysian Grand Prix")."""
    is_image = lambda t: re.search(r"\.(jpe?g|png|webp|tiff?)$", t, re.I)  # noqa: E731
    files = [t for t in category_members(category, "file") if is_image(t)]
    for sub in category_members(category, "subcat"):
        if len(files) >= limit:
            break
        files += [t for t in category_members(sub[len("Category:"):], "file") if is_image(t) and t not in files]
    return files[:limit]


def year_categories(category):
    """The person's "<category> in <year>" categories, nearest to 2016 first ("<category> by year")."""
    years = []
    for sub in category_members(f"{category} by year", "subcat"):
        m = re.search(r" in (\d{4})$", sub)
        if m:
            years.append(int(m.group(1)))
    return sorted(years, key=lambda y: (abs(y - 2016), y))


def file_info(titles, width):
    out = {}
    for i in range(0, len(titles), 40):
        r = commons(action="query", prop="imageinfo", titles="|".join(titles[i:i + 40]),
                    iiprop="url|extmetadata|size", iiurlwidth=width)
        for page in r.get("query", {}).get("pages", {}).values():
            ii = (page.get("imageinfo") or [None])[0]
            if not ii:
                continue
            meta = ii.get("extmetadata", {})
            text = lambda k: re.sub(r"<[^>]+>", "", meta.get(k, {}).get("value", "")).strip()  # noqa: E731
            out[page["title"]] = {
                "thumb": ii.get("thumburl") or ii["url"], "page": ii.get("descriptionurl"),
                "artist": text("Artist"), "license": text("LicenseShortName"), "date": text("DateTimeOriginal")[:10],
            }
    return out


def fetch(args):
    identity = load(os.path.join(args.work, "identity.json"), {})
    out = load(os.path.join(args.work, "candidates.json"), {})
    cache = os.path.join(args.work, "cache")
    for key, who in identity.items():
        if not who.get("qid") or (key in out and not args.refresh):
            continue
        sources = []
        if who.get("category"):
            years = year_categories(who["category"])
            # 2016, 2015, 2017 first, then the nearest other years, then the whole category.
            for y in list(YEARS) + [y for y in years if y not in YEARS]:
                sources.append((f"{who['category']} in {y}", y))
            sources.append((who["category"], None))
        cands = []
        for cat, year in sources:
            titles = category_files(cat, PER_CATEGORY)
            if not titles:
                continue
            info = file_info(titles, DETECT_WIDTH)
            # Thumbnails come from upload.wikimedia.org, which takes a few at a time; the API stays serial.
            with ThreadPoolExecutor(4) as pool:
                blobs = dict(zip(info, pool.map(lambda m: fetch_bytes(m["thumb"], cache), info.values())))
            for title, meta in info.items():
                data = blobs[title]
                if not data:
                    continue
                size, found = faces(data)
                s = score_photo(size, found)
                if s is None:
                    continue
                # 2016 first, then the nearest years.
                bonus = max(0.0, 0.3 - 0.15 * abs(year - 2016)) if year else 0.0
                cands.append({"file": title, "year": year, "score": round(s + bonus, 4), **meta})
            # Enough from 2016, or enough from near years: stop looking further back or forward.
            if (year == 2016 and sum(1 for c in cands if c["year"] == 2016) >= 4) or (year not in YEARS and len(cands) >= 4):
                break
        if who.get("image") and not any(c["file"] == f"File:{who['image']}" for c in cands):
            title = f"File:{who['image']}"
            meta = file_info([title], DETECT_WIDTH).get(title)
            data = fetch_bytes(meta["thumb"], cache) if meta else None
            if data:
                size, found = faces(data)
                s = score_photo(size, found)
                if s is not None:
                    cands.append({"file": title, "year": None, "score": s, **meta})
        cands.sort(key=lambda c: c["score"], reverse=True)
        out[key] = {"name": who["name"], "candidates": cands[:8]}
        best = cands[0] if cands else None
        print(f"  {who['name']}: {len(cands)} usable" + (f", pick {best['year'] or 'any year'} {best['file'][5:60]}" if best else ""), flush=True)
        save(os.path.join(args.work, "candidates.json"), out)
    save(os.path.join(args.work, "candidates.json"), out)


# ------------------------------------------------------------------------------------------------
# sheet

# ------------------------------------------------------------------------------------------------
# facepack

def embedding(img_rgba, recognizer):
    """SFace feature of the largest face in a PIL image (transparency on grey), or None."""
    import cv2
    import numpy as np
    from PIL import Image
    bg = Image.new("RGB", img_rgba.size, (128, 128, 128))
    img = img_rgba.convert("RGBA")
    bg.paste(img, (0, 0), img)
    bg = bg.resize((bg.width * 2, bg.height * 2), Image.LANCZOS)  # small cut-outs: help the detector
    arr = cv2.cvtColor(np.array(bg), cv2.COLOR_RGB2BGR)
    det = detector()
    det.setInputSize((arr.shape[1], arr.shape[0]))
    _, found = det.detect(arr)
    if found is None:
        return None
    face = max(found, key=lambda f: f[2] * f[3])
    feat = recognizer.feature(recognizer.alignCrop(arr, face)).ravel()
    return feat / np.linalg.norm(feat)


def facepack(args):
    """Match an existing portrait mod's faces to this save's drivers."""
    import cv2
    import numpy as np
    import UnityPy
    from PIL import Image
    if not args.facepack:
        sys.exit("facepack needs --facepack <portrait bundle>")
    recognizer = cv2.FaceRecognizerSF.create(model_file(SFACE_URL), "")
    folder = os.path.join(args.work, "facepack")
    os.makedirs(folder, exist_ok=True)
    faces_ = {}
    for o in UnityPy.load(args.facepack).objects:
        if o.type.name != "Texture2D":
            continue
        tex = o.read()
        path = os.path.join(folder, f"{tex.m_Name}.png")
        tex.image.save(path)
        e = embedding(tex.image, recognizer)
        if e is not None:
            faces_[tex.m_Name] = e
    print(f"{len(faces_)} faces in {args.facepack}")

    drivers = {str(d["index"]): d for d in load(args.drivers, [])}
    cands = load(os.path.join(args.work, "candidates.json"), {})
    scores = []
    for key, entry in cands.items():
        if key not in drivers:
            continue
        feats = []
        for c in entry.get("candidates", [])[:8]:
            prev = os.path.join(args.work, "previews", key, preview_name(c["file"]))
            if os.path.exists(prev):
                e = embedding(Image.open(prev), recognizer)
                if e is not None:
                    feats.append(e)
        if not feats:
            continue
        mat = np.stack(feats)
        for name, f in faces_.items():
            scores.append((float((mat @ f).max()), key, name))
    # Best pairs first; each face and each driver used once.
    matched, used = {}, set()
    for score, key, name in sorted(scores, reverse=True):
        if score < SAME_PERSON:
            break
        if key in matched or name in used:
            continue
        matched[key] = {"face": name, "score": round(score, 3)}
        used.add(name)
    save(os.path.join(args.work, "facepack.json"), matched)
    for key in sorted(matched, key=int):
        print(f"  {drivers[key]['name']}: {matched[key]['face']} ({matched[key]['score']})")
    print(f"{len(matched)} drivers matched, {len(faces_) - len(used)} faces unused; check them on the sheet")


def sheet(args):
    drivers = load(args.drivers, [])
    cands = load(os.path.join(args.work, "candidates.json"), {})
    identity = load(os.path.join(args.work, "identity.json"), {})
    choices = load(os.path.join(args.work, "choices.json"), {})
    pack = load(os.path.join(args.work, "facepack.json"), {})
    rows = []
    for d in drivers:
        key = str(d["index"])
        c = cands.get(key, {}).get("candidates", [])
        who = identity.get(key, {})
        chosen = choices.get(key, default_choice(key, c, pack))
        cells = [f'<label class="opt"><input type="radio" name="{key}" value=""{" checked" if not chosen else ""}><span class="mm">MM face</span></label>']
        if key in pack:
            value = FACEPACK + pack[key]["face"]
            checked = " checked" if chosen == value else ""
            cells.append(
                f'<label class="opt"><input type="radio" name="{key}" value="{value}"{checked}>'
                f'<img class="cut" loading="lazy" src="facepack/{pack[key]["face"]}.png"><span>facepack · {pack[key]["score"]:.2f}</span></label>')
        for cand in c:
            checked = " checked" if cand["file"] == chosen else ""
            year = cand["year"] or "any"
            prev = os.path.join("previews", key, preview_name(cand["file"]))
            if os.path.exists(os.path.join(args.work, prev)):
                img = f'<img class="cut" loading="lazy" src="{prev}" title="{html.escape(cand["file"][5:])}">'
            else:
                img = f'<img loading="lazy" src="{html.escape(cand["thumb"])}">'
            cells.append(
                f'<label class="opt"><input type="radio" name="{key}" value="{html.escape(cand["file"])}"{checked}>'
                f'{img}<span><a href="{html.escape(cand.get("page") or "")}" target="_blank">{year}</a> · {cand["score"]:.2f}</span></label>')
        where = d["team"] or "Free agent"
        note = "" if who.get("qid") else f' <em>{html.escape(who.get("why", "not resolved"))}</em>'
        rows.append(f'<section><h3>{html.escape(d["name"])} <small>#{d["index"]} · {html.escape(where)}'
                    f'{" · " + html.escape(d["championship"]) if d["championship"] else ""}</small>{note}</h3>'
                    f'<div class="row">{"".join(cells)}</div></section>')
    page = f"""<!doctype html><meta charset="utf-8"><title>Driver portraits</title>
<style>
:root{{color-scheme:light dark;--bg:#111;--fg:#eee;--muted:#999;--ring:#e10600}}
@media (prefers-color-scheme:light){{:root{{--bg:#fafafa;--fg:#111;--muted:#666}}}}
body{{background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif;margin:0;padding:16px}}
header{{position:sticky;top:0;background:var(--bg);padding:8px 0;display:flex;gap:12px;align-items:center;z-index:1}}
section{{margin:14px 0}} h3{{margin:4px 0;font-size:15px}} small,em{{color:var(--muted);font-weight:400}}
.row{{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}}
.opt{{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;font-size:11px;color:var(--muted)}}
.opt input{{display:none}} .opt img,.mm{{width:120px;height:150px;object-fit:cover;border-radius:6px;outline:2px solid transparent}}
.opt img.cut{{width:128px;height:128px;object-fit:contain;background:#2d2d32}} a{{color:inherit}}
.mm{{display:flex;align-items:center;justify-content:center;background:#333;color:#ccc}}
.opt input:checked+img,.opt input:checked+.mm{{outline-color:var(--ring)}}
button{{font:inherit;padding:6px 12px;border-radius:6px;border:0;background:var(--ring);color:#fff;cursor:pointer}}
</style>
<header><b>Driver portraits</b><span>Pick a photo per driver (red outline), or MM face.</span>
<button id="save">Download choices.json</button></header>
{''.join(rows)}
<script>
document.getElementById('save').onclick=()=>{{
  const out={{}};document.querySelectorAll('input[type=radio]:checked').forEach(i=>out[i.name]=i.value);
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{{type:'application/json'}}));
  a.download='choices.json';a.click();
}};
</script>"""
    path = os.path.join(args.work, "sheet.html")
    with open(path, "w", encoding="utf8") as f:
        f.write(page)
    print(f"wrote {path}: {len(rows)} drivers")


def default_choice(key, candidates, pack):
    """A matched facepack face first, else the best-ranked photo."""
    if key in pack:
        return FACEPACK + pack[key]["face"]
    return candidates[0]["file"] if candidates else ""


# ------------------------------------------------------------------------------------------------
# build

def crop_portrait(image_bytes):
    """Head and shoulders around the largest face, square, as RGB, with the face centre in the crop."""
    from PIL import Image
    size, found = faces(image_bytes)
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    if not found:
        return None, None
    x, y, fw, fh, *_ = max(found, key=lambda f: f[2] * f[3])
    # Room above for hair and caps, shoulders below.
    side = 3.0 * fw
    cx = x + fw / 2
    top = y - 0.95 * fh
    box = [cx - side / 2, top, cx + side / 2, top + side]
    # Pad with edge colour when the box leaves the photo.
    pad = int(max(0, -box[0], -box[1], box[2] - img.width, box[3] - img.height)) + 1
    if pad > 1:
        bg = Image.new("RGB", (img.width + 2 * pad, img.height + 2 * pad), img.getpixel((0, 0)))
        bg.paste(img, (pad, pad))
        img = bg
        box = [v + pad for v in box]
    out = SIZE * 2
    scale = out / side
    centre = ((cx + (pad if pad > 1 else 0) - box[0]) * scale, (y + fh / 2 + (pad if pad > 1 else 0) - box[1]) * scale)
    return img.crop(tuple(int(v) for v in box)).resize((out, out), Image.LANCZOS), centre


def keep_subject(cut, centre):
    """Keep only the cut-out shape that holds the face: bystanders' fragments go."""
    import cv2
    import numpy as np
    from PIL import Image
    rgba = np.array(cut)
    alpha = rgba[:, :, 3]
    n, labels = cv2.connectedComponents((alpha > 24).astype(np.uint8), connectivity=8)
    if n <= 2:
        return cut
    cx, cy = int(min(max(centre[0], 0), alpha.shape[1] - 1)), int(min(max(centre[1], 0), alpha.shape[0] - 1))
    label = labels[cy, cx]
    if label == 0:
        # The face centre fell on a gap: take the biggest shape.
        label = 1 + int(np.argmax([(labels == i).sum() for i in range(1, n)]))
    rgba[:, :, 3] = np.where(labels == label, alpha, 0)
    return Image.fromarray(rgba)


def make_portrait(title, work, session):
    """The finished SIZE x SIZE cut-out for a Commons file, or None (no face)."""
    from rembg import remove
    big = file_info([title], BUILD_WIDTH).get(title)
    data = fetch_bytes(big["thumb"], os.path.join(work, "cache-build")) if big else None
    crop, centre = crop_portrait(data) if data else (None, None)
    if crop is None:
        return None
    return keep_subject(remove(crop, session=session, post_process_mask=True), centre).resize((SIZE, SIZE))


def facepack_portrait(path):
    """A facepack face as made for MM (a square headshot on its own background), scaled to SIZE."""
    from PIL import Image
    return Image.open(path).convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS)


def preview_name(title):
    return re.sub(r"[^A-Za-z0-9._-]", "_", title[5:])[-100:] + ".png"


def preview(args):
    """Every candidate's finished cut-out, for the contact sheet."""
    from rembg import new_session
    cands = load(os.path.join(args.work, "candidates.json"), {})
    session = new_session("u2net_human_seg")
    for key, entry in cands.items():
        folder = os.path.join(args.work, "previews", key)
        os.makedirs(folder, exist_ok=True)
        for c in entry.get("candidates", []):
            path = os.path.join(folder, preview_name(c["file"]))
            if os.path.exists(path):
                continue
            img = make_portrait(c["file"], args.work, session)
            if img is not None:
                img.resize((128, 128)).save(path)
        print(f"  {entry['name']}", flush=True)


def build(args):
    from rembg import new_session
    drivers = {str(d["index"]): d for d in load(args.drivers, [])}
    cands = load(os.path.join(args.work, "candidates.json"), {})
    choices = load(os.path.join(args.work, "choices.json"), {})
    pack = load(os.path.join(args.work, "facepack.json"), {})
    session = new_session("u2net_human_seg")
    png_dir = os.path.join(args.work, "png")
    os.makedirs(png_dir, exist_ok=True)
    pairs, credits = [], []
    for key, entry in cands.items():
        if key not in drivers:
            continue
        options = entry.get("candidates", [])
        chosen = choices.get(key, default_choice(key, options, pack))
        if not chosen:
            continue
        if chosen.startswith(FACEPACK):
            out = os.path.join(png_dir, f"{key}.png")
            facepack_portrait(os.path.join(args.work, "facepack", chosen[len(FACEPACK):] + ".png")).save(out)
            pairs.append(f"Driver_{key}={out}")
            credits.append(f"| {entry['name']} | {chosen[len(FACEPACK):]} | Enzoli's Facepack for 2016 Mod (Steam Workshop 857892735) | as published |")
            print(f"  {entry['name']}: Driver_{key} (facepack)", flush=True)
            continue
        cand = next((c for c in options if c["file"] == chosen), None)
        meta = cand or file_info([chosen], BUILD_WIDTH).get(chosen)
        if not meta:
            print(f"  {entry['name']}: {chosen} not found", flush=True)
            continue
        cut = make_portrait(chosen, args.work, session)
        if cut is None:
            print(f"  {entry['name']}: no face found in {chosen}", flush=True)
            continue
        out = os.path.join(png_dir, f"{key}.png")
        cut.save(out)
        pairs.append(f"Driver_{key}={out}")
        credits.append(f"| {entry['name']} | [{chosen[5:]}]({meta.get('page')}) | {meta.get('artist') or '?'} | {meta.get('license') or '?'} |")
        print(f"  {entry['name']}: Driver_{key}", flush=True)
    with open(os.path.join(args.work, "CREDITS.md"), "w", encoding="utf8") as f:
        f.write("# Driver portrait credits\n\nPhotos from Wikimedia Commons, cropped and cut out for MM.\n\n"
                "| Driver | Photo | Author | Licence |\n|---|---|---|---|\n" + "\n".join(credits) + "\n")
    if not pairs:
        sys.exit("No portraits built")
    if not args.template:
        sys.exit("build needs --template: an existing image mod bundle, e.g. MM_Data/Modding/Images/teamlogos")
    dst = os.path.join(args.work, "Modding", "Images", "portraits")
    subprocess.run([sys.executable, os.path.join(HERE, "portraits.py"), args.template, dst, *pairs], check=True)
    print(f"{len(pairs)} portraits; credits in {os.path.join(args.work, 'CREDITS.md')}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("stage", choices=["resolve", "fetch", "preview", "facepack", "sheet", "build"])
    p.add_argument("--work", default="out/portraits")
    p.add_argument("--drivers", default=None)
    p.add_argument("--template", default=None)
    p.add_argument("--overrides", default=None, help="resolve: JSON {driver name or index: {qid} | {skip: true}}")
    p.add_argument("--facepack", default=None, help="facepack: an existing Images/portraits mod bundle")
    p.add_argument("--refresh", action="store_true", help="fetch: look again for drivers already done")
    args = p.parse_args()
    args.drivers = args.drivers or os.path.join(args.work, "drivers.json")
    os.makedirs(args.work, exist_ok=True)
    {"resolve": resolve, "fetch": fetch, "preview": preview, "facepack": facepack, "sheet": sheet, "build": build}[args.stage](args)


if __name__ == "__main__":
    main()
