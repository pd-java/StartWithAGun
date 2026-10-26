"""屏幕/窗口截图与点击工具（逆向调试用）。

用法：
  python tools/winio.py shot <out.bmp>            # 截整个主屏（真实屏幕坐标）
  python tools/winio.py click <x> <y>             # 在屏幕坐标点击左键
  python tools/winio.py drag <x1> <y1> <x2> <y2>  # 拖拽
  python tools/winio.py focus "<窗口标题片段>"     # 前置窗口
"""
import ctypes
import ctypes.wintypes as wt
import struct
import sys
import time

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
user32.SetProcessDPIAware()

SRCCOPY = 0x00CC0020
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def grab(path, x=0, y=0, w=None, h=None):
    sw, sh = screen_size()
    w = w or sw
    h = h or sh
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc_mem, hbmp)
    gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, SRCCOPY)

    class BIH(ctypes.Structure):
        _fields_ = [("biSize", wt.DWORD), ("biWidth", ctypes.c_long),
                    ("biHeight", ctypes.c_long), ("biPlanes", wt.WORD),
                    ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                    ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                    ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wt.DWORD),
                    ("biClrImportant", wt.DWORD)]

    bi = BIH()
    bi.biSize = ctypes.sizeof(BIH)
    bi.biWidth = w
    bi.biHeight = -h
    bi.biPlanes = 1
    bi.biBitCount = 32
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bi), 0)
    row = w * 4
    with open(path, "wb") as f:
        f.write(b"BM")
        f.write(struct.pack("<IHHI", 14 + 40 + row * h, 0, 0, 54))
        f.write(struct.pack("<IiiHHIIiiII", 40, w, -h, 1, 32, 0, row * h, 2835, 2835, 0, 0))
        f.write(buf.raw)
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_screen)
    return w, h


def click(x, y):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.08)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.06)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


def drag(x1, y1, x2, y2, steps=14):
    user32.SetCursorPos(int(x1), int(y1))
    time.sleep(0.08)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    for i in range(1, steps + 1):
        user32.SetCursorPos(int(x1 + (x2 - x1) * i / steps), int(y1 + (y2 - y1) * i / steps))
        time.sleep(0.03)
    time.sleep(0.1)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


def focus(fragment):
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, _):
        if not user32.IsWindowVisible(h):
            return True
        n = user32.GetWindowTextLengthW(h)
        if n == 0:
            return True
        b = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(h, b, n + 1)
        if fragment in b.value:
            found.append((h, b.value))
        return True

    user32.EnumWindows(cb, 0)
    if not found:
        print("未找到窗口")
        return 1
    h, t = found[0]
    user32.ShowWindow(h, 9)
    user32.SetForegroundWindow(h)
    time.sleep(0.4)
    print("focused", h, t)
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "shot":
        w, h = grab(sys.argv[2])
        print(f"saved {sys.argv[2]} {w}x{h}")
    elif cmd == "click":
        click(int(sys.argv[2]), int(sys.argv[3]))
        print("clicked", sys.argv[2], sys.argv[3])
    elif cmd == "drag":
        drag(*[int(v) for v in sys.argv[2:6]])
        print("dragged")
    elif cmd == "focus":
        sys.exit(focus(sys.argv[2]))
    else:
        print(__doc__)
