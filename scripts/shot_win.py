"""截取指定标题的窗口（置前、按窗口矩形裁剪），用于桌面端真实渲染验收。

    python scripts/shot_win.py [窗口标题] [输出路径]

不依赖 PowerShell / pywin32，只用 ctypes + Pillow。
"""

import ctypes
import ctypes.wintypes as wt
import sys
import time

from PIL import ImageGrab

TARGET = sys.argv[1] if len(sys.argv) > 1 else "LanDrop"
OUT = sys.argv[2] if len(sys.argv) > 2 else "qa/desktop-app.png"

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
user32.ShowWindow(hwnd, 9)  # SW_RESTORE
user32.SetForegroundWindow(hwnd)
user32.BringWindowToTop(hwnd)
time.sleep(0.8)

rect = wt.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
box = (rect.left, rect.top, rect.right, rect.bottom)
img = ImageGrab.grab(bbox=box, all_screens=True)
img.save(OUT)
print(f"window {rect.right - rect.left} x {rect.bottom - rect.top} at ({rect.left},{rect.top}) -> {OUT}")
