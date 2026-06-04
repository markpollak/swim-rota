"""Generate PWA icons (brand-blue tile with white swimming waves) without PIL.

Writes PNGs into static/. Pure stdlib (zlib + struct).
"""
import zlib
import struct
import math
import os

STATIC = os.path.join(os.path.dirname(__file__), "static")
BLUE = (0x26, 0x35, 0x8B)
MAGENTA = (0xA4, 0x35, 0x8B)
WHITE = (255, 255, 255)


def png(width, height, pixels):
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        for x in range(width):
            raw.extend(pixels[y * width + x])
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (sig + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def draw(size, pad_ratio=0.0):
    """Brand tile: blue rounded square + three white waves + magenta accent wave."""
    px = [(255, 255, 255, 0)] * (size * size)
    pad = int(size * pad_ratio)
    inner = size - 2 * pad
    radius = inner * 0.22

    def rounded(x, y):
        rx, ry = x - pad, y - pad
        if rx < 0 or ry < 0 or rx >= inner or ry >= inner:
            return False
        cx = min(max(rx, radius), inner - radius)
        cy = min(max(ry, radius), inner - radius)
        return (rx - cx) ** 2 + (ry - cy) ** 2 <= radius ** 2 or (
            radius <= rx <= inner - radius or radius <= ry <= inner - radius)

    def wave_y(x, base, amp, freq, phase):
        return base + amp * math.sin(freq * (x - pad) / inner * 2 * math.pi + phase)

    waves = [
        (0.42, WHITE), (0.56, WHITE), (0.70, MAGENTA), (0.84, WHITE),
    ]
    thickness = inner * 0.055
    for y in range(size):
        for x in range(size):
            if not rounded(x, y):
                continue
            color = BLUE
            for base_r, wcol in waves:
                wy = wave_y(x, pad + inner * base_r, inner * 0.05, 2.0, base_r * 6)
                if abs(y - wy) <= thickness:
                    color = wcol
            px[y * size + x] = (color[0], color[1], color[2], 255)
    return px


def write(name, size, pad_ratio=0.0):
    data = png(size, size, draw(size, pad_ratio))
    with open(os.path.join(STATIC, name), "wb") as f:
        f.write(data)
    print(f"wrote {name} ({size}x{size}, {len(data)} bytes)")


if __name__ == "__main__":
    os.makedirs(STATIC, exist_ok=True)
    write("icon-192.png", 192)
    write("icon-512.png", 512)
    write("icon-maskable-512.png", 512, pad_ratio=0.14)
    write("apple-touch-icon.png", 180)
    print("done")
