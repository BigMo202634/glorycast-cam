# Sign an unsigned APK with APK Signature Scheme v2 (what Android 7+ checks), using openssl and the
# GloryCast key (gcp/tech/glorycast-cam/android/signing). For when Maven Central (apksig) can't be reached.
#   python3 tools/sign_apk_v2.py IN-unsigned.apk OUT.apk KEY.p12 PASSWORD_FILE
# Then: python3 tools/sign_apk_v2.py --verify OUT.apk
import hashlib, os, struct, subprocess, sys, tempfile, zipfile

V2_ID = 0x7109871A
RSA_SHA256 = 0x0103
MAGIC = b"APK Sig Block 42"
CHUNK = 1 << 20


def lp(b):  # uint32 length-prefixed
    return struct.pack("<I", len(b)) + b


def zip_parts(data):
    """(start of central directory, end of central directory record offset) for a zip with no comment tricks"""
    eocd = data.rfind(b"PK\x05\x06", max(0, len(data) - 65557))
    if eocd < 0: raise SystemExit("not a zip")
    cd_off = struct.unpack_from("<I", data, eocd + 16)[0]
    return cd_off, eocd


def digest(sections):
    chunks = []
    for s in sections:
        for i in range(0, len(s), CHUNK):
            c = s[i:i + CHUNK]
            chunks.append(hashlib.sha256(b"\xa5" + struct.pack("<I", len(c)) + c).digest())
    return hashlib.sha256(b"\x5a" + struct.pack("<I", len(chunks)) + b"".join(chunks)).digest()


def check_aligned(path):
    """Android 11+ refuses an app whose stored (uncompressed) files are not 4-byte aligned (.so: 4096)"""
    bad = []
    with zipfile.ZipFile(path) as z, open(path, "rb") as f:
        for i in z.infolist():
            if i.compress_type != zipfile.ZIP_STORED: continue
            f.seek(i.header_offset + 26)
            n, m = struct.unpack("<HH", f.read(4))
            start = i.header_offset + 30 + n + m
            need = 4096 if i.filename.endswith(".so") else 4
            if start % need: bad.append(i.filename)
    return bad


def openssl(*args, data=None):
    return subprocess.run(["openssl", *args], input=data, capture_output=True, check=True).stdout


def sign(src, out, p12, pwfile):
    data = open(src, "rb").read()
    bad = check_aligned(src)
    if bad: raise SystemExit("not aligned (run zipalign first): " + ", ".join(bad[:5]))
    cd_off, eocd = zip_parts(data)
    if data[cd_off - 16:cd_off] == MAGIC: raise SystemExit("already signed")
    entries, cd, end = data[:cd_off], data[cd_off:eocd], data[eocd:]
    top = digest([entries, cd, end])
    with tempfile.TemporaryDirectory() as t:
        key, crt = os.path.join(t, "k.pem"), os.path.join(t, "c.pem")
        openssl("pkcs12", "-in", p12, "-passin", "file:" + pwfile, "-nocerts", "-nodes", "-out", key)
        openssl("pkcs12", "-in", p12, "-passin", "file:" + pwfile, "-nokeys", "-clcerts", "-out", crt)
        cert = openssl("x509", "-in", crt, "-outform", "DER")
        pub = openssl("pkey", "-in", key, "-pubout", "-outform", "DER")
        signed = lp(lp(struct.pack("<I", RSA_SHA256) + lp(top))) + lp(lp(cert)) + lp(b"")
        sig = openssl("dgst", "-sha256", "-sign", key, data=signed)
    signer = lp(signed) + lp(lp(struct.pack("<I", RSA_SHA256) + lp(sig))) + lp(pub)
    value = lp(lp(signer))
    pair = struct.pack("<QI", 4 + len(value), V2_ID) + value
    size = len(pair) + 8 + 16
    block = struct.pack("<Q", size) + pair + struct.pack("<Q", size) + MAGIC
    new_end = end[:16] + struct.pack("<I", cd_off + len(block)) + end[20:]
    with open(out, "wb") as f: f.write(entries + block + cd + new_end)


def verify(path):
    data = open(path, "rb").read()
    cd_off, eocd = zip_parts(data)
    if data[cd_off - 16:cd_off] != MAGIC: raise SystemExit("no APK signing block")
    size = struct.unpack_from("<Q", data, cd_off - 24)[0]
    start = cd_off - size - 8
    assert struct.unpack_from("<Q", data, start)[0] == size
    p, pairs = start + 8, {}
    while p < cd_off - 24:
        n, i = struct.unpack_from("<QI", data, p); pairs[i] = data[p + 12:p + 8 + n]; p += 8 + n
    v = pairs[V2_ID]
    rd = lambda b, o: (b[o + 4:o + 4 + struct.unpack_from("<I", b, o)[0]], o + 4 + struct.unpack_from("<I", b, o)[0])
    signers, _ = rd(v, 0); signer, _ = rd(signers, 0)
    signed, o = rd(signer, 0); sigs, o = rd(signer, o); pub, o = rd(signer, o)
    digs, so = rd(signed, 0); certs, so = rd(signed, so)
    d1, _ = rd(digs, 0); alg = struct.unpack_from("<I", d1, 0)[0]; want, _ = rd(d1, 4)
    s1, _ = rd(sigs, 0); sig, _ = rd(s1, 4)
    end = data[eocd:]; end = end[:16] + struct.pack("<I", start) + end[20:]
    got = digest([data[:start], data[cd_off:eocd], end])
    with tempfile.TemporaryDirectory() as t:
        pk, sg = os.path.join(t, "p.der"), os.path.join(t, "s.bin")
        open(pk, "wb").write(pub); open(sg, "wb").write(sig)
        r = subprocess.run(["openssl", "dgst", "-sha256", "-keyform", "DER", "-verify", pk, "-signature", sg], input=signed, capture_output=True)
    cert, _ = rd(certs, 0)
    cpub = subprocess.run(["openssl", "x509", "-inform", "DER", "-pubkey", "-noout"], input=cert, capture_output=True).stdout
    cpub = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"], input=cpub, capture_output=True).stdout
    ok = alg == RSA_SHA256 and want == got and r.returncode == 0 and cpub == pub and not check_aligned(path)
    print("v2 signature", "OK" if ok else "BAD", "| digest", want == got, "| signature", r.returncode == 0, "| cert matches key", cpub == pub)
    print("certificate SHA-256", hashlib.sha256(cert).hexdigest())
    zipfile.ZipFile(path).testzip()
    return ok


if __name__ == "__main__":
    if sys.argv[1] == "--verify": sys.exit(0 if verify(sys.argv[2]) else 1)
    sign(*sys.argv[1:5]); sys.exit(0 if verify(sys.argv[2]) else 1)
