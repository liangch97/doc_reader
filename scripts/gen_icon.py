"""Generate high-quality app icons for Tauri from a clean vector-like design."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, struct, io

ICONS_DIR = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons')
SIZE = 1024  # Master size

def create_master_icon(size=SIZE):
    """Create a clean, modern Doc Reader icon at high resolution."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Rounded square background with gradient effect
    margin = int(size * 0.08)
    radius = int(size * 0.20)
    
    # Draw base shape - deep purple
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        fill=(100, 70, 220, 255)
    )
    
    # Lighter overlay at top for gradient feel
    overlay = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle(
        [margin, margin, size - margin, int(size * 0.55)],
        radius=radius,
        fill=(140, 110, 255, 60)
    )
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)
    
    # Draw a stylized open book / document
    cx, cy = size // 2, int(size * 0.48)
    
    # Book spine (center line)
    spine_w = int(size * 0.015)
    spine_top = int(size * 0.25)
    spine_bot = int(size * 0.72)
    draw.line([(cx, spine_top), (cx, spine_bot)], fill=(255, 255, 255, 200), width=spine_w)
    
    # Left page
    lx1, ly1 = int(size * 0.22), int(size * 0.27)
    lx2, ly2 = cx - int(size * 0.02), int(size * 0.70)
    draw.rounded_rectangle([lx1, ly1, lx2, ly2], radius=int(size*0.02), fill=(255, 255, 255, 230))
    
    # Right page  
    rx1, ry1 = cx + int(size * 0.02), int(size * 0.27)
    rx2, ry2 = int(size * 0.78), int(size * 0.70)
    draw.rounded_rectangle([rx1, ry1, rx2, ry2], radius=int(size*0.02), fill=(255, 255, 255, 245))
    
    # Text lines on left page
    line_color = (100, 70, 220, 120)
    line_h = int(size * 0.012)
    for i, w_ratio in enumerate([0.7, 0.85, 0.6, 0.75, 0.5]):
        y = ly1 + int(size * 0.06) + i * int(size * 0.055)
        lw = int((lx2 - lx1 - size * 0.06) * w_ratio)
        x_start = lx1 + int(size * 0.03)
        draw.rounded_rectangle(
            [x_start, y, x_start + lw, y + line_h],
            radius=line_h // 2,
            fill=line_color
        )
    
    # Text lines on right page
    for i, w_ratio in enumerate([0.8, 0.65, 0.9, 0.55, 0.7]):
        y = ry1 + int(size * 0.06) + i * int(size * 0.055)
        lw = int((rx2 - rx1 - size * 0.06) * w_ratio)
        x_start = rx1 + int(size * 0.03)
        draw.rounded_rectangle(
            [x_start, y, x_start + lw, y + line_h],
            radius=line_h // 2,
            fill=line_color
        )
    
    # Sparkle / AI indicator (small star at top-right of right page)
    star_cx = rx2 - int(size * 0.06)
    star_cy = ry1 + int(size * 0.04)
    star_r = int(size * 0.035)
    # 4-point star
    points = []
    import math
    for i in range(8):
        angle = math.pi / 4 * i - math.pi / 2
        r = star_r if i % 2 == 0 else star_r * 0.4
        points.append((star_cx + r * math.cos(angle), star_cy + r * math.sin(angle)))
    draw.polygon(points, fill=(255, 210, 80, 255))
    
    # "DR" text at bottom
    text_y = int(size * 0.76)
    try:
        font = ImageFont.truetype("arial.ttf", int(size * 0.12))
    except:
        font = ImageFont.load_default()
    
    bbox = draw.textbbox((0, 0), "DR", font=font)
    tw = bbox[2] - bbox[0]
    draw.text((cx - tw // 2, text_y), "DR", fill=(255, 255, 255, 220), font=font)
    
    return img


def save_resized(master, target_size, path):
    """Resize with high quality LANCZOS and save."""
    resized = master.resize((target_size, target_size), Image.LANCZOS)
    # Sharpen small icons to reduce blur
    if target_size <= 64:
        from PIL import ImageEnhance
        enhancer = ImageEnhance.Sharpness(resized)
        resized = enhancer.enhance(1.5 if target_size <= 32 else 1.2)
    resized.save(path, 'PNG')
    return resized


def create_ico(master, path):
    """Create ICO with multiple sizes, all LANCZOS-resampled."""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = []
    for s in sizes:
        img = master.resize((s, s), Image.LANCZOS)
        if s <= 64:
            from PIL import ImageEnhance
            img = ImageEnhance.Sharpness(img).enhance(1.5 if s <= 32 else 1.2)
        images.append(img)
    
    # Use PIL's ICO save  
    # Save the 256 as the base, include all sizes
    master_256 = master.resize((256, 256), Image.LANCZOS)
    master_256.save(path, format='ICO', sizes=[(s, s) for s in sizes])


def main():
    print("Generating master icon (1024x1024)...")
    master = create_master_icon(1024)
    
    os.makedirs(ICONS_DIR, exist_ok=True)
    
    # Save master as high-res source
    master.save(os.path.join(ICONS_DIR, 'icon_master.png'), 'PNG')
    
    # Tauri required PNGs
    print("Generating PNG variants...")
    save_resized(master, 32, os.path.join(ICONS_DIR, '32x32.png'))
    save_resized(master, 128, os.path.join(ICONS_DIR, '128x128.png'))
    save_resized(master, 256, os.path.join(ICONS_DIR, '128x128@2x.png'))
    save_resized(master, 128, os.path.join(ICONS_DIR, 'icon.png'))
    
    # Square logos for Windows store
    for s in [30, 44, 71, 89, 107, 142, 150, 284, 310]:
        save_resized(master, s, os.path.join(ICONS_DIR, f'Square{s}x{s}Logo.png'))
    save_resized(master, 50, os.path.join(ICONS_DIR, 'StoreLogo.png'))
    
    # ICO for Windows
    print("Generating icon.ico...")
    create_ico(master, os.path.join(ICONS_DIR, 'icon.ico'))
    
    # ICNS for macOS
    print("Generating icon.icns (as PNG fallback)...")
    save_resized(master, 256, os.path.join(ICONS_DIR, 'icon.icns'))
    
    print("Done! All icons generated.")


if __name__ == '__main__':
    main()
