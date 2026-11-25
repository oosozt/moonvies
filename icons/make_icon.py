# Draws the app icon (retro sun over a neon grid, with a play symbol) at every size the phone needs.
# Run: python icons/make_icon.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

S = 1024
OUT = Path(__file__).parent
BG, PINK, AMBER, CYAN, INK = (10, 5, 32), (255, 46, 136), (255, 225, 77), (61, 242, 255), (10, 5, 32)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw():
    img = Image.new('RGB', (S, S), BG)
    # purple haze behind the sun
    haze = Image.new('RGB', (S, S), BG)
    hd = ImageDraw.Draw(haze)
    for r in range(520, 0, -8):
        hd.ellipse([S / 2 - r, 430 - r, S / 2 + r, 430 + r], fill=lerp(BG, (70, 18, 110), 1 - r / 520))
    img = Image.blend(img, haze.filter(ImageFilter.GaussianBlur(30)), 1)

    # the sun: amber at the top to pink at the bottom, cut by stripes in its lower half
    cx, cy, R = S / 2, 450, 300
    sun = Image.new('RGB', (S, S))
    sd = ImageDraw.Draw(sun)
    for y in range(int(cy - R), int(cy + R)):
        sd.line([(0, y), (S, y)], fill=lerp(AMBER, PINK, (y - (cy - R)) / (2 * R)))
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([cx - R, cy - R, cx + R, cy + R], fill=255)
    gap, y = 10, cy + 30
    while y < cy + R:
        md.rectangle([0, y, S, y + gap], fill=0)
        y += gap + 34 - gap * 0.6
        gap += 6
    glow = Image.new('RGB', (S, S), PINK)
    img.paste(glow, (0, 0), mask.filter(ImageFilter.GaussianBlur(40)).point(lambda v: v * 0.55))
    img.paste(sun, (0, 0), mask)

    # the floor: a cyan perspective grid below the horizon
    d = ImageDraw.Draw(img)
    horizon = 640
    d.rectangle([0, horizon, S, S], fill=BG)
    grid = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for i in range(-12, 13):
        gd.line([(cx + i * 18, horizon), (cx + i * 150, S)], fill=CYAN + (255,), width=6)
    k = 0
    while True:
        y = horizon + 8 * (1.42 ** k)
        if y > S:
            break
        gd.line([(0, y), (S, y)], fill=CYAN + (255,), width=6)
        k += 1
    fade = Image.new('L', (S, S), 0)
    fdraw = ImageDraw.Draw(fade)
    for y in range(horizon, S):
        fdraw.line([(0, y), (S, y)], fill=int(90 + 165 * (y - horizon) / (S - horizon)))
    grid.putalpha(Image.composite(grid.getchannel('A'), Image.new('L', (S, S), 0), fade).point(lambda v: v * 0.9))
    soft = grid.filter(ImageFilter.GaussianBlur(10))
    img.paste(soft, (0, 0), soft)
    img.paste(grid, (0, 0), grid)
    d.line([(0, horizon), (S, horizon)], fill=PINK, width=8)

    # play symbol on the sun
    t = [(cx - 95, cy - 130), (cx - 95, cy + 130), (cx + 140, cy)]
    shadow = Image.new('L', (S, S), 0)
    ImageDraw.Draw(shadow).polygon(t, fill=200)
    img.paste(Image.new('RGB', (S, S), (60, 0, 40)), (14, 14), shadow.filter(ImageFilter.GaussianBlur(12)))
    d.polygon(t, fill=INK)
    return img


img = draw()
for name, size in [('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180), ('favicon-32.png', 32)]:
    img.resize((size, size), Image.LANCZOS).save(OUT / name)
print('ok')
