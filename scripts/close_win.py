"""向窗口发送 WM_CLOSE，验证"关闭窗口不停止服务"。"""

import ctypes
import ctypes.wintypes as wt

user32 = ctypes.windll.user32
WM_CLOSE = 0x0010
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
if not found:
    print("no visible window")
else:
    for hwnd in found:
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    print(f"sent WM_CLOSE to {len(found)} window(s)")
