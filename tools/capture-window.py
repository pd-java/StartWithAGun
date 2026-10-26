"""用 Win32 API 截取指定进程主窗口（供逆向对比用）。"""
import ctypes
import ctypes.wintypes as wt
import sys
import os

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

SRCCOPY = 0x00CC0020
PW_RENDERFULLCONTENT = 0x2


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def find_hwnd_by_pid(pid):
    """枚举顶层窗口，返回该 pid 的可见主窗口句柄列表（按面积降序）。"""
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        wpid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid and user32.IsWindowVisible(hwnd):
            r = RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            w, h = r.right - r.left, r.bottom - r.top
            if w > 50 and h > 50:
                found.append((w * h, hwnd, r))
        return True

    user32.EnumWindows(cb, 0)
    found.sort(reverse=True, key=lambda x: x[0])
    return found


def capture(hwnd, rect, path):
    w, h = rect.right - rect.left, rect.bottom - rect.top
    hdc_win = user32.GetWindowDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_win, w, h)
    gdi32.SelectObject(hdc_mem, hbmp)
    ok = user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wt.DWORD), ("biWidth", ctypes.c_long),
                    ("biHeight", ctypes.c_long), ("biPlanes", wt.WORD),
                    ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                    ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                    ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wt.DWORD),
                    ("biClrImportant", wt.DWORD)]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h  # 负值 = 自上而下
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0

    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bi), 0)

    # 写 BMP（BGRA）
    import struct
    row = w * 4
    with open(path, "wb") as f:
        f.write(b"BM")
        f.write(struct.pack("<IHHI", 14 + 40 + row * h, 0, 0, 54))
        f.write(struct.pack("<IiiHHIIiiII", 40, w, -h, 1, 32, 0, row * h, 2835, 2835, 0, 0))
        f.write(buf.raw)

    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(hwnd, hdc_win)
    return ok, w, h


if __name__ == "__main__":
    pid = int(sys.argv[1])
    out = sys.argv[2]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    wins = find_hwnd_by_pid(pid)
    if not wins:
        print("未找到可见窗口")
        sys.exit(1)
    for area, hwnd, rect in wins[:3]:
        print(f"hwnd={hwnd} rect=({rect.left},{rect.top})-({rect.right},{rect.bottom}) "
              f"size={rect.right-rect.left}x{rect.bottom-rect.top}")
    area, hwnd, rect = wins[0]
    ok, w, h = capture(hwnd, rect, out)
    print(f"PrintWindow={ok} saved={out} {w}x{h}")
