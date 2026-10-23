#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

"""Import pinned Fluent Flat artwork and bilingual Emojibase annotations.

Run with python3 (macOS/Linux) or py -3 (Windows). Only release maintenance
needs network access; normal install/build/runtime uses the checked-in files.
Archives are streamed without extracting paths supplied by a remote archive.
"""

import hashlib
import io
import json
from pathlib import Path
import tarfile
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
FLUENT_COMMIT = "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc"
EMOJIBASE_VERSION = "18.0.0"
EMOJIBASE_SHA1 = "a64ddfa7579ea27a90c0b7728ff8054bdab199eb"
TONES = ["Default", "Light", "Medium-Light", "Medium", "Medium-Dark", "Dark"]


def fetch(url):
    return urlopen(Request(url, headers={"User-Agent": "Onward-emoji-import"}), timeout=120)


def key_for(emoji):
    return "-".join(format(ord(char), "x") for char in emoji if char != "\ufe0f")


def annotations(data):
    result = {}
    for entry in data:
        result[key_for(entry["emoji"])] = entry
        for skin in entry.get("skins", []):
            result[key_for(skin["emoji"])] = {**entry, **skin}
    return result


def main():
    base_url = f"https://registry.npmjs.org/emojibase-data/-/emojibase-data-{EMOJIBASE_VERSION}.tgz"
    with fetch(base_url) as response:
        data = response.read()
    if hashlib.sha1(data).hexdigest() != EMOJIBASE_SHA1:
        raise ValueError("Emojibase archive integrity mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        locales = {locale: annotations(json.load(archive.extractfile(f"package/{locale}/data.json"))) for locale in ("en", "zh")}
        data_license = archive.extractfile("package/LICENSE").read().decode()
    del data
    metadata, images = {}, {}
    artwork_license = None
    url = f"https://codeload.github.com/microsoft/fluentui-emoji/tar.gz/{FLUENT_COMMIT}"
    with fetch(url) as response, tarfile.open(fileobj=response, mode="r|gz") as archive:
        for member in archive:
            if not member.isfile():
                continue
            relative = member.name.split("/", 1)[-1]
            if relative == "LICENSE":
                artwork_license = archive.extractfile(member).read().decode()
            elif relative.startswith("assets/") and relative.endswith("/metadata.json"):
                metadata[relative.split("/")[1]] = json.load(archive.extractfile(member))
            elif relative.startswith("assets/") and "/Flat/" in relative and relative.endswith(".svg"):
                images[relative] = archive.extractfile(member).read()
    if not artwork_license or len(images) != 3145:
        raise ValueError("Pinned Fluent archive is incomplete")

    target = ROOT / "public" / "prompt-emoji"
    asset_dir = target / "flat"
    asset_dir.mkdir(parents=True, exist_ok=True)
    catalog, provenance = {}, {}
    for source, svg in sorted(images.items()):
        parts = source.split("/")
        meta = metadata[parts[1]]
        sequence = meta["unicode"]
        if len(parts) == 5:
            sequence = meta["unicodeSkintones"][TONES.index(parts[2])]
        emoji = "".join(chr(int(code, 16)) for code in sequence.split())
        key = key_for(emoji)
        en, zh = locales["en"].get(key), locales["zh"].get(key)
        if not en or not zh:
            raise ValueError(f"Missing bilingual annotation: {source} ({key})")
        if key in catalog:
            raise ValueError(f"Duplicate artwork identity: {source} ({key})")
        # Artwork is rendered as an image, never inserted as executable SVG DOM.
        root = ET.fromstring(svg)
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] in ("script", "foreignObject"):
                raise ValueError(f"Active SVG element: {source}")
            if any(attr.lower().startswith("on") or (attr.endswith("href") and not value.startswith("#")) for attr, value in element.attrib.items()):
                raise ValueError(f"Active SVG attribute: {source}")
        (asset_dir / f"{key}.svg").write_bytes(svg)
        catalog[key] = {
            "key": key, "emoji": en["emoji"], "group": en["group"],
            "en": en["label"], "zh": zh["label"],
            "keywords": sorted(set(en.get("tags", []) + zh.get("tags", []) + meta.get("keywords", []))),
            "order": en["order"],
        }
        provenance[key] = {"path": source, "sha256": hashlib.sha256(svg).hexdigest()}
    entries = sorted(catalog.values(), key=lambda item: item.pop("order"))
    for previous in asset_dir.glob("*.svg"):
        if previous.stem not in catalog:
            previous.unlink()
    generated = ROOT / "src" / "data" / "prompt-emoji-manifest.ts"
    generated.parent.mkdir(parents=True, exist_ok=True)
    (generated.parent / "prompt-emoji-catalog.json").write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    generated.write_text(
        "/*\n * SPDX-FileCopyrightText: 2026 OPPO\n * SPDX-License-Identifier: Apache-2.0\n */\n\n"
        "// Generated by scripts/import-prompt-emoji.py. Data notices: resources/emoji/ThirdPartyNotices.txt.\n"
        "// Only the compact identity list loads at startup; search annotations stay in the Worker.\n"
        "export const PROMPT_EMOJI_VALUES: readonly string[] = " + json.dumps([entry["emoji"] for entry in entries], ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8", newline="\n")
    notices = ROOT / "resources" / "emoji"
    notices.mkdir(parents=True, exist_ok=True)
    unicode_license = (notices / "Unicode-LICENSE.txt").read_text(encoding="utf-8")
    (notices / "ThirdPartyNotices.txt").write_text(
        f"Microsoft Fluent Emoji (Flat SVG)\nSource: https://github.com/microsoft/fluentui-emoji/tree/{FLUENT_COMMIT}\n\n"
        + artwork_license + f"\n\nEmojibase data {EMOJIBASE_VERSION} (English and Simplified Chinese annotations)\n"
        + "Source: https://github.com/milesj/emojibase\n\n" + data_license
        + "\n\nUnicode / CLDR data\n\n" + unicode_license, encoding="utf-8", newline="\n")
    (notices / "provenance.json").write_text(json.dumps({
        "fluentCommit": FLUENT_COMMIT, "emojibaseVersion": EMOJIBASE_VERSION,
        "emojibaseArchiveSha1": EMOJIBASE_SHA1, "artworkCount": len(entries),
        "artworkBytes": sum(map(len, images.values())), "assets": provenance,
    }, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"entries": len(entries), "artworkBytes": sum(map(len, images.values()))}))


if __name__ == "__main__":
    main()
