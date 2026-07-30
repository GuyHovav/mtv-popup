"""Generate Pop-up Video launcher icons.

A homage to the show's title card rather than a copy of it: the same cyan
bevelled type on a black plaque over liquid chrome, with the logo's
concentric ring standing in for the O. Deliberately omits the VH1 "1" bug,
which is someone else's trademark.
"""

import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
M = 1024  # master design canvas

# Adaptive icons are 108dp with only the inner 72dp guaranteed visible, so
# foreground content stays inside ~0.66 of the canvas. Legacy bitmaps are
# masked by us instead of the system, so they can fill much more.
ADAPTIVE_MARK_W = 560
LEGACY_MARK_W = 700

DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]
ADAPTIVE_PX = [108, 162, 216, 324, 432]
LEGACY_PX = [48, 72, 96, 144, 192]

LETTER_STOPS = [
    (0.00, (242, 254, 255)),
    (0.30, (127, 230, 255)),
    (0.55, (31, 176, 236)),
    (1.00, (10, 95, 150)),
]
CHROME_STOPS = [
    (0.00, (246, 249, 252)),
    (0.42, (193, 203, 214)),
    (0.54, (233, 239, 244)),
    (1.00, (135, 146, 158)),
]
PLAQUE = (6, 7, 12, 255)


def vgrad(w, h, stops):
    col = Image.new("RGB", (1, max(1, h)))
    px = col.load()
    stops = sorted(stops)
    for y in range(max(1, h)):
        t = y / max(1, h - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if p0 <= t <= p1:
                f = (t - p0) / max(1e-6, p1 - p0)
                px[0, y] = tuple(round(c0[j] + (c1[j] - c0[j]) * f) for j in range(3))
                break
        else:
            px[0, y] = stops[-1][1]
    return col.resize((w, max(1, h)), Image.BILINEAR)


def geometry(mark_w):
    """Font size and positions so P + ring + P spans exactly mark_w."""
    base = 400
    probe = ImageFont.truetype(FONT, base)
    b = probe.getbbox("P")
    pw, cap = b[2] - b[0], b[3] - b[1]
    span = 2 * pw + 2 * (cap * 0.12) + cap
    font = ImageFont.truetype(FONT, max(8, int(base * mark_w / span)))

    bb = font.getbbox("P")
    pw, cap = bb[2] - bb[0], bb[3] - bb[1]
    gap, ring_d = cap * 0.12, cap
    total = 2 * pw + 2 * gap + ring_d
    x, cy = (M - total) / 2, M / 2
    top = cy - cap / 2
    return {
        "font": font,
        "cap": cap,
        "top": top,
        "total": total,
        "x": x,
        "p1": (x - bb[0], top - bb[1]),
        "p2": (x + pw + gap + ring_d + gap - bb[0], top - bb[1]),
        "ring": [
            x + pw + gap,
            cy - ring_d / 2,
            x + pw + gap + ring_d,
            cy + ring_d / 2,
        ],
        # Thin enough that the counter reads as the logo's concentric ring.
        "ring_t": ring_d * 0.235,
    }


def stamp(draw, g, ring_width, stroke=0, fill=255):
    kw = {"font": g["font"], "fill": fill}
    if stroke:
        kw.update(stroke_width=int(stroke), stroke_fill=fill)
    draw.text(g["p1"], "P", **kw)
    draw.text(g["p2"], "P", **kw)
    draw.ellipse(g["ring"], outline=fill, width=max(1, int(ring_width)))


def build_foreground(mark_w, with_plaque=True):
    g = geometry(mark_w)
    cap = g["cap"]
    img = Image.new("RGBA", (M, M), (0, 0, 0, 0))

    if with_plaque:
        pad_x, pad_y = cap * 0.30, cap * 0.34
        box = [
            g["x"] - pad_x,
            g["top"] - pad_y,
            g["x"] + g["total"] + pad_x,
            g["top"] + cap + pad_y,
        ]
        # Cool halo so the black plaque separates from the chrome behind it.
        halo = Image.new("L", (M, M), 0)
        ImageDraw.Draw(halo).rounded_rectangle(box, radius=cap * 0.40, fill=120)
        halo = halo.filter(ImageFilter.GaussianBlur(cap * 0.10))
        img.paste(Image.new("RGBA", (M, M), (40, 90, 130, 255)), (0, 0), halo)
        ImageDraw.Draw(img).rounded_rectangle(
            box,
            radius=cap * 0.40,
            fill=PLAQUE,
            outline=(120, 200, 235, 255),
            width=max(2, int(cap * 0.022)),
        )

    # Glyph mask, then the same shapes dilated for a black keyline beneath.
    mask = Image.new("L", (M, M), 0)
    stamp(ImageDraw.Draw(mask), g, g["ring_t"])

    key = Image.new("L", (M, M), 0)
    stroke = max(2, int(cap * 0.05))
    stamp(ImageDraw.Draw(key), g, g["ring_t"] + stroke * 2, stroke=stroke)
    img.paste(Image.new("RGBA", (M, M), PLAQUE), (0, 0), key)

    grad = Image.new("RGB", (M, M))
    grad.paste(vgrad(M, int(cap), LETTER_STOPS), (0, int(g["top"])))
    img.paste(grad, (0, 0), mask)

    glow = Image.new("RGBA", (M, M), (0, 0, 0, 0))
    glow.paste((110, 220, 255, 130), (0, 0), mask)
    glow = glow.filter(ImageFilter.GaussianBlur(cap * 0.07))
    return Image.alpha_composite(glow, img)


def build_background():
    bg = vgrad(M, M, CHROME_STOPS).convert("RGBA")
    streak = Image.new("L", (M, M), 0)
    ImageDraw.Draw(streak).polygon(
        [(-200, 780), (M, 120), (M, 400), (-200, 1050)], fill=95
    )
    bg.paste(
        Image.new("RGBA", (M, M), (255, 255, 255, 255)),
        (0, 0),
        streak.filter(ImageFilter.GaussianBlur(70)),
    )
    return bg


def build_monochrome(mark_w):
    """Solid plaque with the type knocked out, for Android 13+ themed icons."""
    g = geometry(mark_w)
    cap = g["cap"]
    pad_x, pad_y = cap * 0.30, cap * 0.34
    img = Image.new("RGBA", (M, M), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle(
        [
            g["x"] - pad_x,
            g["top"] - pad_y,
            g["x"] + g["total"] + pad_x,
            g["top"] + cap + pad_y,
        ],
        radius=cap * 0.40,
        fill=(255, 255, 255, 255),
    )
    holes = Image.new("L", (M, M), 0)
    stamp(ImageDraw.Draw(holes), g, g["ring_t"])
    img.paste((0, 0, 0, 0), (0, 0), holes)
    return img


def masked(img, circle):
    mask = Image.new("L", (M, M), 0)
    d = ImageDraw.Draw(mask)
    if circle:
        d.ellipse([0, 0, M - 1, M - 1], fill=255)
    else:
        d.rounded_rectangle([0, 0, M - 1, M - 1], radius=int(M * 0.19), fill=255)
    out = Image.new("RGBA", (M, M), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def save_set(res_dir, name, master, pixels):
    for dens, px in zip(DENSITIES, pixels):
        d = os.path.join(res_dir, f"mipmap-{dens}")
        os.makedirs(d, exist_ok=True)
        master.resize((px, px), Image.LANCZOS).save(os.path.join(d, f"{name}.png"))


def main():
    res_dir = sys.argv[1]
    preview_dir = sys.argv[2] if len(sys.argv) > 2 else None

    fg = build_foreground(ADAPTIVE_MARK_W)
    bg = build_background()
    mono = build_monochrome(ADAPTIVE_MARK_W)
    legacy = Image.alpha_composite(bg, build_foreground(LEGACY_MARK_W))

    save_set(res_dir, "ic_launcher_foreground", fg, ADAPTIVE_PX)
    save_set(res_dir, "ic_launcher_background", bg, ADAPTIVE_PX)
    save_set(res_dir, "ic_launcher_monochrome", mono, ADAPTIVE_PX)
    save_set(res_dir, "ic_launcher", masked(legacy, circle=False), LEGACY_PX)
    save_set(res_dir, "ic_launcher_round", masked(legacy, circle=True), LEGACY_PX)

    if preview_dir:
        adaptive = masked(Image.alpha_composite(bg, fg), circle=True)
        adaptive.save(os.path.join(preview_dir, "preview.png"))
        sheet = Image.new("RGBA", (620, 210), (125, 125, 125, 255))
        xo = 10
        for s in (192, 144, 96, 72, 48):
            r = adaptive.resize((s, s), Image.LANCZOS)
            sheet.paste(r, (xo, 10), r)
            xo += s + 12
        sheet.save(os.path.join(preview_dir, "sizes.png"))
        # Themed-icon check: tinted monochrome on a flat surface.
        t = Image.new("RGBA", (M, M), (28, 34, 48, 255))
        tint = Image.new("RGBA", (M, M), (168, 205, 255, 255))
        t.paste(tint, (0, 0), mono.split()[3])
        masked(t, circle=True).resize((256, 256), Image.LANCZOS).save(
            os.path.join(preview_dir, "themed.png")
        )
    print("icons written to", res_dir)


if __name__ == "__main__":
    main()
