# The TV app's launcher icons and its home-screen banner, from the catalog's own icon.
# Run: python tv-app/make_art.py   (build.ps1 runs it)
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).parent
ICON = Image.open(HERE.parent / 'icons' / 'icon-512.png').convert('RGB')
RES = HERE / 'res'

for folder, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    d = RES / f'mipmap-{folder}'
    d.mkdir(parents=True, exist_ok=True)
    ICON.resize((size, size), Image.LANCZOS).save(d / 'ic_launcher.png')

# Banner: 320x180 dp, drawn at xhdpi (640x360). The icon's sun and grid on the left, the name on the right.
W, H = 640, 360
BG, PINK, PINK_SOFT, CYAN = (10, 5, 32), (255, 46, 136), (255, 138, 209), (61, 242, 255)
b = Image.new('RGB', (W, H), BG)
art = ICON.resize((H, H), Image.LANCZOS)
fade = Image.new('L', (H, H), 255)
fd = ImageDraw.Draw(fade)
for x in range(H):  # soften the icon's right edge into the background
    fd.line([(x, 0), (x, H)], fill=int(255 * min(1, (H - x) / 120)))
b.paste(art, (0, 0), fade)


def font(size):
    for name in ['seguisb.ttf', 'segoeuib.ttf', 'arialbd.ttf', 'consolab.ttf']:
        try:
            return ImageFont.truetype(f'C:/Windows/Fonts/{name}', size)
        except OSError:
            pass
    return ImageFont.load_default()


def glow_text(xy, text, f, fill, glow):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text(xy, text, font=f, fill=glow + (255,))
    b.paste(layer.filter(ImageFilter.GaussianBlur(9)), (0, 0), layer.filter(ImageFilter.GaussianBlur(9)))
    ImageDraw.Draw(b).text(xy, text, font=f, fill=fill)


glow_text((350, 96), 'MOON', font(72), PINK_SOFT, PINK)
glow_text((350, 176), 'VIES', font(72), CYAN, CYAN)
ImageDraw.Draw(b).line([(352, 262), (600, 262)], fill=PINK, width=4)
d = RES / 'drawable-xhdpi'
d.mkdir(parents=True, exist_ok=True)
b.save(d / 'banner.png')
print('art ok')
