# Icon and TV banner for Glass Home: the colour fields with a frosted pane in front.
import os
from PIL import Image, ImageDraw, ImageFilter

here = os.path.dirname(os.path.abspath(__file__))

def fields(w, h):
    img = Image.new('RGB', (w, h), (11, 13, 30))
    for (cx, cy, r, col) in [(.18, .22, .55, (59, 76, 255)), (.82, .72, .6, (193, 61, 255)), (.6, .08, .4, (0, 179, 164))]:
        layer = Image.new('RGB', (w, h), col)
        mask = Image.new('L', (w, h), 0)
        d = ImageDraw.Draw(mask)
        R = r * max(w, h)
        d.ellipse([cx * w - R / 2, cy * h - R / 2, cx * w + R / 2, cy * h + R / 2], fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(R / 4))
        img = Image.composite(layer, img, mask)
    return img

def pane(img, box, radius):
    over = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    d.rounded_rectangle(box, radius, fill=(255, 255, 255, 46), outline=(255, 255, 255, 120), width=max(2, img.size[0] // 160))
    return Image.alpha_composite(img.convert('RGBA'), over)

def save(img, rel):
    p = os.path.join(here, 'res', rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.convert('RGB').save(p)

# banner 320x180 (xhdpi): fields, a pane, and the name
b = fields(640, 360)
b = pane(b, (40, 70, 600, 290), 40)
d = ImageDraw.Draw(b)
try:
    from PIL import ImageFont
    f = ImageFont.truetype(os.path.join(here, 'assets', 'fonts', 'Outfit.ttf'), 96)
    f.set_variation_by_axes([500])
except Exception:
    f = None
d.text((320, 182), 'Glass Home', fill=(255, 255, 255), font=f, anchor='mm')
save(b.resize((320, 180), Image.LANCZOS), 'drawable-xhdpi/banner.png')

# launcher icon
for name, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    i = fields(size * 4, size * 4)
    i = pane(i, (size * .8, size * .8, size * 3.2, size * 3.2), size * .5)
    save(i.resize((size, size), Image.LANCZOS), f'mipmap-{name}/ic_launcher.png')
print('art ok')
