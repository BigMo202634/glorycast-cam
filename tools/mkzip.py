# Zip a folder, marking .command/.sh files and Mac app launchers (.app/Contents/MacOS) executable so they open on a Mac.
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(os.path.abspath(src))
tmp = out + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        # Folder entries too, as a Mac's own zips have, so Finder sees GloryCast Cam.app as an app when unzipped.
        d = os.path.relpath(root, base).replace(os.sep, "/") + "/"
        zd = zipfile.ZipInfo(d, zipfile.ZipInfo.from_file(root, d).date_time)
        zd.external_attr = (0o040755 << 16) | 0x10
        z.writestr(zd, b"")
        for f in sorted(files):
            p = os.path.join(root, f); arc = os.path.relpath(p, base)
            zi = zipfile.ZipInfo.from_file(p, arc)
            exe = f.endswith((".command", ".sh")) or ".app/Contents/MacOS/" in arc.replace(os.sep, "/")
            mode = 0o755 if exe else 0o644
            zi.external_attr = (0o100000 | mode) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(p, "rb") as fh: z.writestr(zi, fh.read())
os.replace(tmp, out)
