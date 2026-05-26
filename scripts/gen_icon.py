"""Generate sharp-edged line-art icons for Doc Reader (Tauri).

Design language:
  - Pure white square background (no corner rounding)
  - LEFT page: blue (#0078D4) sharp-cornered trapezoid outline
  - RIGHT page: black (#1A1A1A) sharp-cornered trapezoid outline
  - A small gap between pages so the two colors stay separate
  - Per-page text lines (square caps, no rounding)

Stroke is rendered by filling the outer polygon, then "carving" the inner
polygon (offset by stroke width along inward edge normals) with the
background color — this gives clean, sharp miter joins that PIL's
ImageDraw.line does not natively provide.
"""
from PIL import Image, ImageDraw, ImageEnhance
import math
import os

ICONS_DIR = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons')
FAVICON_PATH = os.path.join(os.path.dirname(__file__), '..', 'public', 'favicon.svg')
SIZE = 1024

# === Palette ===
BG_FILL = (242, 234, 211, 255)       # #F2EAD3  warm cream — outer canvas
BG_PAPER = (255, 255, 255, 255)      # #FFFFFF  book page interior (crisp paper)
BG_HAIRLINE = (214, 200, 171, 255)   # #D6C8AB  subtle edge ring
BLUE = (0, 122, 204, 255)            # #0078D4
BLACK = (26, 26, 26, 255)            # #1A1A1A

CORNER_RADIUS_RATIO = 0.22           # iOS-style squircle radius

# === Layout (ratios of canvas size) ===
PAGE_L = (0.195, 0.288, 0.494, 0.246, 0.494, 0.769, 0.195, 0.727)
PAGE_R = (0.506, 0.246, 0.805, 0.288, 0.805, 0.727, 0.506, 0.769)
PAGE_STROKE_RATIO_L = 0.028   # left page: thinner blue stroke
PAGE_STROKE_RATIO_R = 0.043   # right page: thicker black stroke (unchanged)
HAIRLINE_RATIO = 0.003

# --- Spiral stairs (2D bars arranged on a helix projection) ---
N_STEPS = 14                  # number of bars per page (covers 360° once)
SPIRAL_R_RATIO = 0.040        # horizontal swing radius (≈ 41 px)
SPIRAL_MAX_LEN_RATIO = 0.135  # widest bar length (≈ 138 px)
SPIRAL_MIN_LEN_FRAC = 0.18    # shortest bar = 18% of max
SPIRAL_BAR_H_RATIO = 0.014    # bar thickness (≈ 14 px)
SPIRAL_TOP_RATIO = 0.300      # vertical range inside each page
SPIRAL_BOT_RATIO = 0.715
SPIRAL_BACK_ALPHA = 0.30      # opacity of "back-facing" bars

L_CENTER_X_RATIO = 0.3445     # left page horizontal center (inside stroke)
R_CENTER_X_RATIO = 0.6555     # right page horizontal center

PAGE_TOP_RATIO = 0.246
PAGE_BOT_RATIO = 0.769


# ----------------------------------------------------------------------
# Geometry — inset a convex polygon along each edge's inward normal
# ----------------------------------------------------------------------
def _line_intersect(p1, p2, p3, p4):
    x1, y1 = p1
    x2, y2 = p2
    x3, y3 = p3
    x4, y4 = p4
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-9:
        return ((p2[0] + p3[0]) / 2.0, (p2[1] + p3[1]) / 2.0)
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))


def stroke_round_polygon(draw, points, width, color):
    """Stroke a closed polygon with rounded corners.

    Implements an approximation of SVG stroke-linejoin="round" using PIL:
    a line segment for each edge plus a filled circle at each vertex
    (diameter = stroke width) covering the BUTT-cap gap.
    """
    closed = list(points) + [points[0]]
    for i in range(len(closed) - 1):
        draw.line([closed[i], closed[i + 1]], fill=color, width=width)
    r = width / 2
    for x, y in points:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def compute_spiral_bars(size, x_c):
    """Compute spiral-staircase 2D bars for one page.

    Returns a list of (z, x0, y0, x1, y1, is_back) sorted back-to-front.
    Each bar is a horizontal 2D rectangle whose center sweeps in a circle
    (cos for x, sin for depth z) — a parallel projection of a helix.
    """
    n = N_STEPS
    r = int(size * SPIRAL_R_RATIO)
    max_len = int(size * SPIRAL_MAX_LEN_RATIO)
    min_len = max(2, int(max_len * SPIRAL_MIN_LEN_FRAC))
    bar_h = max(2, int(size * SPIRAL_BAR_H_RATIO))
    top_y = int(size * SPIRAL_TOP_RATIO)
    bot_y = int(size * SPIRAL_BOT_RATIO)
    y_step = (bot_y - top_y - bar_h) / max(1, n - 1)

    bars = []
    for i in range(n):
        # Half-step offset so first bar isn't at the degenerate θ=0
        theta = (i + 0.5) / n * 2 * math.pi
        z = math.sin(theta)                             # depth: + front, - back
        x_offset = r * math.cos(theta)                  # horizontal swing
        # Length follows |sin| (foreshortening of a bar viewed from the side)
        length = max(min_len, int(max_len * abs(math.sin(theta)) ** 0.5))
        x_center = x_c + x_offset
        x0 = int(x_center - length / 2)
        x1 = int(x_center + length / 2)
        y0 = int(top_y + i * y_step)
        y1 = y0 + bar_h
        bars.append((z, x0, y0, x1, y1, z < 0))

    bars.sort(key=lambda b: b[0])  # back first, so front bars overlap them
    return bars


def inset_convex_polygon(points, distance):
    """Return a polygon offset inward by `distance` along each edge's normal.
    Works correctly for convex polygons (matches SVG miter joins)."""
    n = len(points)
    cx = sum(p[0] for p in points) / n
    cy = sum(p[1] for p in points) / n

    inset_edges = []
    for i in range(n):
        p1 = points[i]
        p2 = points[(i + 1) % n]
        ex = p2[0] - p1[0]
        ey = p2[1] - p1[1]
        elen = math.hypot(ex, ey) or 1.0
        ex, ey = ex / elen, ey / elen
        nx, ny = -ey, ex  # left-hand normal
        mx = (p1[0] + p2[0]) / 2.0
        my = (p1[1] + p2[1]) / 2.0
        if (cx - mx) * nx + (cy - my) * ny < 0:
            nx, ny = -nx, -ny
        ip1 = (p1[0] + nx * distance, p1[1] + ny * distance)
        ip2 = (p2[0] + nx * distance, p2[1] + ny * distance)
        inset_edges.append((ip1, ip2))

    new_points = []
    for i in range(n):
        e1 = inset_edges[(i - 1) % n]
        e2 = inset_edges[i]
        new_points.append(_line_intersect(e1[0], e1[1], e2[0], e2[1]))
    return new_points


# ----------------------------------------------------------------------
# Icon composition
# ----------------------------------------------------------------------
def create_master_icon(size=SIZE):
    icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)

    # 1. Cream rounded-square background
    corner_r = int(size * CORNER_RADIUS_RATIO)
    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=corner_r, fill=BG_FILL,
    )

    # 2. Faint edge ring so the icon stays visible on cream pages
    hw = max(1, int(size * 0.003))
    draw.rounded_rectangle(
        [hw // 2, hw // 2, size - 1 - hw // 2, size - 1 - hw // 2],
        radius=corner_r - hw // 2, outline=BG_HAIRLINE, width=hw,
    )

    stroke_w_L = max(4, int(size * PAGE_STROKE_RATIO_L))   # ≈ 28 at 1024
    stroke_w_R = max(6, int(size * PAGE_STROKE_RATIO_R))   # ≈ 44 at 1024

    # Left page (blue) — tight gap with right page
    L = [
        (int(size * 0.195), int(size * 0.288)),   # outer top-left
        (int(size * 0.494), int(size * 0.246)),   # inner top (V fold point)
        (int(size * 0.494), int(size * 0.769)),   # inner bottom (V fold point)
        (int(size * 0.195), int(size * 0.727)),   # outer bottom-left
    ]
    # Right page (black) — mirrored
    R = [
        (int(size * 0.506), int(size * 0.246)),   # inner top
        (int(size * 0.805), int(size * 0.288)),   # outer top-right
        (int(size * 0.805), int(size * 0.727)),   # outer bottom-right
        (int(size * 0.506), int(size * 0.769)),   # inner bottom
    ]

    # 3a. Left page — white paper inside + thin blue round stroke on top
    draw.polygon(inset_convex_polygon(L, stroke_w_L / 2.0), fill=BG_PAPER)
    stroke_round_polygon(draw, L, stroke_w_L, BLUE)

    # 3b. Right page — thick black miter stroke via outer fill + white carve
    draw.polygon(R, fill=BLACK)
    draw.polygon(inset_convex_polygon(R, stroke_w_R), fill=BG_PAPER)

    # 4. Spiral staircase per page — 2D bars projected from a helix
    spiral_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(spiral_layer)
    back_alpha = int(255 * SPIRAL_BACK_ALPHA)

    for x_c, base_rgb in [
        (int(size * L_CENTER_X_RATIO), BLUE[:3]),
        (int(size * R_CENTER_X_RATIO), BLACK[:3]),
    ]:
        for z, x0, y0, x1, y1, is_back in compute_spiral_bars(size, x_c):
            alpha = back_alpha if is_back else 255
            sd.rectangle([x0, y0, x1, y1], fill=base_rgb + (alpha,))

    icon = Image.alpha_composite(icon, spiral_layer)

    return icon


# ----------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------
def _resize(master, target):
    img = master.resize((target, target), Image.LANCZOS)
    if target <= 64:
        img = ImageEnhance.Sharpness(img).enhance(1.5 if target <= 32 else 1.2)
    return img


def save_resized(master, target, path):
    _resize(master, target).save(path, 'PNG')


def create_ico(master, path):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    base = master.resize((256, 256), Image.LANCZOS)
    base.save(path, format='ICO', sizes=[(s, s) for s in sizes])


# ----------------------------------------------------------------------
# SVG generator (favicon) — mirrors the PIL layout
# ----------------------------------------------------------------------
def _hex(rgb):
    return '#{:02X}{:02X}{:02X}'.format(*rgb[:3])


def generate_svg(path, size=SIZE):
    sw_L = max(4, int(size * PAGE_STROKE_RATIO_L))
    sw_R = max(6, int(size * PAGE_STROKE_RATIO_R))
    hw = max(1, int(size * HAIRLINE_RATIO))

    def to_px(ratios):
        return [(int(ratios[i] * size), int(ratios[i + 1] * size))
                for i in range(0, len(ratios), 2)]

    def poly_d(pts):
        return 'M ' + ' L '.join(f'{x} {y}' for x, y in pts) + ' Z'

    Lp = to_px(PAGE_L)
    Rp = to_px(PAGE_R)

    # Spiral bars for each page, in back-to-front draw order
    spiral_rects = []
    for x_c_ratio, color_rgb in [
        (L_CENTER_X_RATIO, BLUE[:3]),
        (R_CENTER_X_RATIO, BLACK[:3]),
    ]:
        x_c = int(size * x_c_ratio)
        color_hex = _hex(color_rgb)
        for z, x0, y0, x1, y1, is_back in compute_spiral_bars(size, x_c):
            op = SPIRAL_BACK_ALPHA if is_back else 1.0
            spiral_rects.append(
                f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" '
                f'fill="{color_hex}" opacity="{op:.2f}"/>'
            )

    corner_r = int(size * CORNER_RADIUS_RATIO)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" fill="none">
  <!-- Cream rounded-square background -->
  <rect width="{size}" height="{size}" rx="{corner_r}" ry="{corner_r}" fill="{_hex(BG_FILL)}"/>
  <rect x="{hw/2}" y="{hw/2}" width="{size-hw}" height="{size-hw}" rx="{corner_r-hw/2:.1f}" ry="{corner_r-hw/2:.1f}" fill="none" stroke="{_hex(BG_HAIRLINE)}" stroke-width="{hw}"/>

  <!-- Left page — white paper with thin blue rounded-corner border -->
  <path d="{poly_d(Lp)}" fill="{_hex(BG_PAPER)}" stroke="{_hex(BLUE)}" stroke-width="{sw_L}"
        stroke-linecap="round" stroke-linejoin="round"/>
  <!-- Right page — white paper with thick black miter border -->
  <path d="{poly_d(Rp)}" fill="{_hex(BG_PAPER)}" stroke="{_hex(BLACK)}" stroke-width="{sw_R}"
        stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="10"/>

  <!-- Spiral staircase: 2D bars projected from a helix (N={N_STEPS} per page) -->
  <g shape-rendering="crispEdges">
    {chr(10).join('    ' + r for r in spiral_rects)}
  </g>
</svg>
'''

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(svg)


def main():
    print('Generating master icon (1024x1024)...')
    master = create_master_icon(1024)

    os.makedirs(ICONS_DIR, exist_ok=True)
    master.save(os.path.join(ICONS_DIR, 'icon_master.png'), 'PNG')

    print('Generating PNG variants...')
    save_resized(master, 32, os.path.join(ICONS_DIR, '32x32.png'))
    save_resized(master, 128, os.path.join(ICONS_DIR, '128x128.png'))
    save_resized(master, 256, os.path.join(ICONS_DIR, '128x128@2x.png'))
    save_resized(master, 128, os.path.join(ICONS_DIR, 'icon.png'))

    for s in [30, 44, 71, 89, 107, 142, 150, 284, 310]:
        save_resized(master, s, os.path.join(ICONS_DIR, f'Square{s}x{s}Logo.png'))
    save_resized(master, 50, os.path.join(ICONS_DIR, 'StoreLogo.png'))

    print('Generating icon.ico...')
    create_ico(master, os.path.join(ICONS_DIR, 'icon.ico'))

    print('Generating icon.icns (PNG fallback)...')
    save_resized(master, 256, os.path.join(ICONS_DIR, 'icon.icns'))

    print('Generating favicon.svg ...')
    generate_svg(FAVICON_PATH)

    print('Done! All icons generated under', os.path.normpath(ICONS_DIR))


if __name__ == '__main__':
    main()
