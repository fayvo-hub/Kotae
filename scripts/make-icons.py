#!/usr/bin/env python3
"""生成应用图标与托盘图标。

图标是品牌资产，改设计只要改这里的参数再重新运行：

    python scripts/make-icons.py

产物：
    resources/icon.png   1024×1024，进 exe、安装包与 Dock
    resources/tray.png   32×32，托盘图标；带渐变底与圆角，深浅任务栏都看得见
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "resources"

# 品牌渐变：靛蓝 → 紫罗兰，与界面里的 --accent 一致。
TOP = (124, 108, 255)
BOTTOM = (88, 60, 232)
WHITE = (255, 255, 255, 255)

SUPERSAMPLE = 4


def gradient(size: int) -> Image.Image:
    """左上到右下的线性渐变，作为图标底色。"""
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    last = size - 1
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * last)
            px[x, y] = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
    return grad


def add_highlight(img: Image.Image, size: int) -> None:
    """左上角一层很淡的高光，避免大面积纯渐变显得扁平。"""
    glow = Image.new("L", (size, size), 0)
    ImageDraw.Draw(glow).ellipse(
        (-size * 0.35, -size * 0.6, size * 0.9, size * 0.5), fill=80
    )
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.07))
    img.paste(Image.new("RGBA", (size, size), WHITE), (0, 0), glow)


def stroke(draw: ImageDraw.ImageDraw, points, width: int) -> None:
    """圆头折线：PIL 的 line 只有平头，两端补圆点。"""
    draw.line(points, fill=WHITE, width=width)
    r = width / 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - r, y - r, x + r, y + r), fill=WHITE)


def draw_glyph(img: Image.Image, size: int) -> None:
    """中央的 `>_` 提示符：一个折角加一条底线。"""
    draw = ImageDraw.Draw(img)
    width = round(size * 0.082)

    # 折角（>）：交点在左中部。
    left_x = size * 0.375
    right_x = size * 0.508
    mid_y = size * 0.5
    stroke(draw, [(left_x, size * 0.338), (right_x, mid_y)], width)
    stroke(draw, [(right_x, mid_y), (left_x, size * 0.662)], width)

    # 底线（_）：略低于中点。
    line_y = size * 0.662
    stroke(draw, [(size * 0.565, line_y), (size * 0.723, line_y)], width)


def rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    inset = round(size * 0.018)
    ImageDraw.Draw(mask).rounded_rectangle(
        (inset, inset, size - inset - 1, size - inset - 1),
        radius=round(size * radius_ratio),
        fill=255,
    )
    return mask


def build(size: int, radius_ratio: float) -> Image.Image:
    big = size * SUPERSAMPLE
    canvas = gradient(big).convert("RGBA")
    add_highlight(canvas, big)
    draw_glyph(canvas, big)
    canvas.putalpha(rounded_mask(big, radius_ratio))
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    RES.mkdir(parents=True, exist_ok=True)
    app_icon = build(1024, 0.225)
    app_icon.save(RES / "icon.png", optimize=True)
    tray_icon = build(32, 0.26)
    tray_icon.save(RES / "tray.png", optimize=True)
    print(f"icon.png  {app_icon.width}x{app_icon.height}")
    print(f"tray.png  {tray_icon.width}x{tray_icon.height}")


if __name__ == "__main__":
    main()
