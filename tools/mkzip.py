# Zip a folder, marking .command/.sh files executable so they open on a Mac.
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(os.path.abspath(src))
tmp = out + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(root, f); arc = os.path.relpath(p, base)
            zi = zipfile.ZipInfo.from_file(p, arc)
            mode = 0o755 if f.endswith((".command", ".sh")) else 0o644
            zi.external_attr = (0o100000 | mode) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(p, "rb") as fh: z.writestr(zi, fh.read())
os.replace(tmp, out)
