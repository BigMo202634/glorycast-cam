# Makes app/img/icon.ico (the Windows Start menu, desktop and Settings > Apps icon) from app/img/icon-512.png.
# Run: python3 tools/win-icon.py
import os
from PIL import Image
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
img = Image.open(os.path.join(root, "app", "img", "icon-512.png")).convert("RGBA")
img.save(os.path.join(root, "app", "img", "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
