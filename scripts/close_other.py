"""关闭标题里带指定关键词、但不是精确匹配的窗口（用于清掉测试时弹出的浏览器）。"""

import ctypes
import ctypes.wintypes as wt
import sys

KEYWORD = sys.argv[1] if len(sys.argv) > 1 else "LanDrop"
EXACT_SKIP = sys.argv[2] if len(sys.argv) > 2 else "LanDrop"
WM_CLOSE = 0x0010

user32 = ctypes.windll.user32
closed = []
WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def callback(hwnd, _):
    length = user32.GetWindowTextLengthW(hwnd)
    if length:
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
        if KEYWORD in title and title != EXACT_SKIP and user32.IsWindowVisible(hwnd):
            user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
            closed.append(title)
    return True


user32.EnumWindows(WNDENUMPROC(callback), 0)
print(f"closed {len(closed)}: {closed}")
