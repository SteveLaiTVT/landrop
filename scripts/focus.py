"""把指定标题的窗口置前，方便截屏验收。"""

import ctypes
import ctypes.wintypes as wt
import sys
import time

TARGET = sys.argv[1] if len(sys.argv) > 1 else "LanDrop"

user32 = ctypes.windll.user32
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
    print(f"window not found: {TARGET}")
    sys.exit(1)

hwnd = found[0]
user32.ShowWindow(hwnd, 9)  # SW_RESTORE
user32.SetForegroundWindow(hwnd)
time.sleep(0.8)
print(f"activated hwnd={hwnd}")
