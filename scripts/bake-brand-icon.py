"""Bake OllamaCode desktop/app icon: dark plate + < official-llama > in cyan."""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OFFICIAL = os.path.join(ROOT, "ide", "brand", "ollama-official.png")


def llama_mask(src: Image.Image) -> Image.Image:
    src = src.convert("RGBA")
    w, h = src.size
    px = src.load()
    mask = Image.new("L", (w, h), 0)
    mp = mask.load()
    ink = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 8:
                continue
            lum = (r + g + b) / 3
            # Official app.ico: black strokes/fills on transparent
            if lum < 180:
                v = int(min(255, (200 - lum) * 1.4 * (a / 255.0)))
                mp[x, y] = max(v, 0)
                ink += v
            # Some exports are white body — keep as solid
            elif lum > 230 and a > 200:
                mp[x, y] = 255
                ink += 255
    if ink < 50_000:
        mask = src.split()[-1]
    bbox = mask.getbbox()
    return mask.crop(bbox) if bbox else mask


def bake(size: int = 1024) -> Image.Image:
    mask = llama_mask(Image.open(OFFICIAL))
    cyan = Image.new("RGBA", mask.size, (0x38, 0xBD, 0xF8, 255))
    cyan.putalpha(mask)

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(out)
    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1],
        radius=int(size * 192 / 1024),
        fill=(0x0B, 0x12, 0x20, 255),
    )

    chev = (0x38, 0xBD, 0xF8, 255)
    s = size / 1024
    left = [(340 * s, 200 * s), (170 * s, 512 * s), (340 * s, 824 * s), (250 * s, 824 * s), (80 * s, 512 * s), (250 * s, 200 * s)]
    right = [(684 * s, 200 * s), (854 * s, 512 * s), (684 * s, 824 * s), (774 * s, 824 * s), (944 * s, 512 * s), (774 * s, 200 * s)]
    draw.polygon(left, fill=chev)
    draw.polygon(right, fill=chev)

    max_h = int(560 * s)
    max_w = int(400 * s)
    scale = min(max_w / cyan.width, max_h / cyan.height)
    tw, th = max(1, int(cyan.width * scale)), max(1, int(cyan.height * scale))
    llama = cyan.resize((tw, th), Image.Resampling.LANCZOS)
    out.alpha_composite(llama, ((size - tw) // 2, (size - th) // 2))
    return out


def main() -> None:
    out = bake(1024)
    targets = [
        os.path.join(ROOT, "ide", "icons", "ollamacode.png"),
        os.path.join(ROOT, "ide", "brand", "code-icon-1024.png"),
        os.path.join(ROOT, "ollamacode-icon.png"),
        os.path.join(ROOT, "extensions", "ollama-agent", "media", "icon.png"),
    ]
    for p in targets:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        out.save(p, "PNG")
        print("wrote", p)
    brand = os.path.join(ROOT, "ide", "brand")
    out.resize((48, 48), Image.Resampling.LANCZOS).save(os.path.join(brand, "preview-48.png"), "PNG")
    out.resize((48, 48), Image.Resampling.LANCZOS).save(os.path.join(brand, "brand-48.png"), "PNG")
    out.resize((128, 128), Image.Resampling.LANCZOS).save(os.path.join(brand, "brand-128.png"), "PNG")
    out.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(brand, "preview-256.png"), "PNG")
    out.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(brand, "brand-256.png"), "PNG")
    # Chat model-picker glyph (full-color brand, not a mono mask)
    mp = os.path.join(
        ROOT,
        ".cache",
        "vscode-140",
        "src",
        "vs",
        "workbench",
        "contrib",
        "chat",
        "browser",
        "widget",
        "input",
        "modelPicker",
        "media",
        "ollamacode-brand-48.png",
    )
    if os.path.isdir(os.path.dirname(mp)):
        out.resize((48, 48), Image.Resampling.LANCZOS).save(mp, "PNG")
        print("wrote", mp)
    hub = os.path.join(ROOT, "extensions", "ollama-agent", "media", "hub.png")
    out.save(hub, "PNG")
    print("previews ok")


if __name__ == "__main__":
    main()
