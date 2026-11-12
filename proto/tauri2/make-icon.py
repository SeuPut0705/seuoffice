#!/usr/bin/env python3
"""Writes a 1024x1024 placeholder PNG (a rounded blue square) with the standard library only.
The tauri CLI turns it into the platform icons: tauri icon make-icon.png"""
import struct
import sys
import zlib

size = 1024
radius = 180
blue = (0x25, 0x63, 0xEB, 0xFF)


def inside(x, y):
    cx = min(max(x, radius), size - 1 - radius)
    cy = min(max(y, radius), size - 1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


rows = bytearray()
for y in range(size):
    rows.append(0)
    for x in range(size):
        rows += bytes(blue) if inside(x, y) else b"\x00\x00\x00\x00"


def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
png += chunk(b"IEND", b"")
open(sys.argv[1] if len(sys.argv) > 1 else "make-icon.png", "wb").write(png)
