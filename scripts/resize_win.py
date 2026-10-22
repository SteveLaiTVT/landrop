"""按 CSS 尺寸调整窗口大小（用于短窗口布局验收）。

    python scripts/resize_win.py <宽> <高> [窗口标题]
"""

import ctypes
import ctypes.wintypes as wt
import sys

TARGET = sys.argv[3] if len(sys.argv) > 3 else "LanDrop"
W = int(sys.argv[1]) if len(sys.argv) > 1 else 1100
H = int(sys.argv[2]) if len(sys.argv) > 2 else 640

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()

found = []
WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def callback(hwnd, _):
    length = user32.GetWindowTextLengthW(hwnd)
    if length:
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if buf.value == TARGET and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
    return True


user32.EnumWindows(WNDENUMPROC(callback), 0)
if not found:
    print(f"未找到窗口：{TARGET}")
    raise SystemExit(1)

hwnd = found[0]
rect = wt.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
frame_w = rect.right - rect.left
frame_h = rect.bottom - rect.top
# 若已指定物理尺寸则直接使用；这里按 dpi 缩放换算
scale = user32.GetDpiForWindow(hwnd) / 96 if hasattr(user32, "GetDpiForWindow") else 1.0
pw, ph = int(W * scale), int(H * scale)
user32.SetWindowPos(hwnd, 0, rect.left, rect.top, pw, ph, 0x0004)  # SWP_NOZORDER
print(f"resize {frame_w}x{frame_h} -> {pw}x{ph} (scale {scale:.2f})")
