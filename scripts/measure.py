"""读取窗口实际尺寸与屏幕参数，用于核对窗口大小是否符合预期。"""

import ctypes
import ctypes.wintypes as wt

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()

TARGET = "LanDrop"
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

screen_w = user32.GetSystemMetrics(0)
screen_h = user32.GetSystemMetrics(1)
print(f"screen: {screen_w} x {screen_h}")

for hwnd in found:
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    print(f"hwnd={hwnd}  window: {w} x {h}  at ({rect.left},{rect.top})")
