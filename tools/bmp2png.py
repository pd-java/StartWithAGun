"""把 32bit BMP 转成 PNG（零依赖，仅用 zlib）。"""
import struct
import sys
import zlib


def bmp_to_png(src, dst):
    with open(src, 'rb') as f:
        data = f.read()
    assert data[:2] == b'BM'
    pix_off = struct.unpack('<I', data[10:14])[0]
    hdr_size = struct.unpack('<I', data[14:18])[0]
    w = struct.unpack('<i', data[18:22])[0]
    h = struct.unpack('<i', data[22:26])[0]
    bpp = struct.unpack('<H', data[28:30])[0]
    assert bpp == 32, f'only 32bpp, got {bpp}'
    top_down = h < 0
    h = abs(h)
    row_bytes = w * 4

    raw = bytearray()
    for y in range(h):
        sy = y if top_down else (h - 1 - y)
        off = pix_off + sy * row_bytes
        line = data[off:off + row_bytes]
        raw.append(0)  # filter: none
        # BGRA -> RGB
        out = bytearray(w * 3)
        out[0::3] = line[2::4]
        out[1::3] = line[1::4]
        out[2::3] = line[0::4]
        raw += out

    def chunk(tag, payload):
        c = struct.pack('>I', len(payload)) + tag + payload
        return c + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 6))
    png += chunk(b'IEND', b'')
    with open(dst, 'wb') as f:
        f.write(png)
    return w, h


if __name__ == '__main__':
    w, h = bmp_to_png(sys.argv[1], sys.argv[2])
    print(f'{sys.argv[2]} {w}x{h}')
