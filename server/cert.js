// Makes a self-signed certificate so phones can open the camera page over https
// (phone browsers only allow the camera on secure pages). Node's crypto signs it; the
// certificate itself is assembled here in DER, so no OpenSSL is needed on Windows.
"use strict";
const crypto = require("crypto");

function len(n) {
  if (n < 128) return Buffer.from([n]);
  const b = []; while (n > 0) { b.unshift(n & 255); n >>= 8; }
  return Buffer.from([0x80 | b.length].concat(b));
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = buf => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const bits = buf => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const octets = buf => tlv(0x04, buf);
const utf8 = s => tlv(0x0c, Buffer.from(s, "utf8"));
const bool = v => tlv(0x01, Buffer.from([v ? 0xff : 0]));
function oid(str) {
  const p = str.split(".").map(Number), out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 127]; let x = v >> 7;
    while (x > 0) { b.unshift((x & 127) | 128); x >>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"; // YYMMDDHHMMSSZ
  return tlv(0x17, Buffer.from(s));
}
function ipBytes(ip) { return Buffer.from(ip.split(".").map(Number)); }

// ips: IPv4 addresses of this computer, put in the certificate so it matches the address phones use
function makeCert(ips, days) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const sigAlg = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const name = seq(set(seq(oid("2.5.4.3"), utf8("GloryCast Cam"))), set(seq(oid("2.5.4.10"), utf8("GloryCast HQ"))));
  const now = new Date(Date.now() - 86400000), end = new Date(Date.now() + (days || 365) * 86400000);
  const san = seq(
    tlv(0x82, Buffer.from("localhost")),
    ...ips.map(ip => tlv(0x87, ipBytes(ip))),
    tlv(0x87, ipBytes("127.0.0.1"))
  );
  const exts = tlv(0xa3, seq(
    seq(oid("2.5.29.19"), bool(true), octets(seq())),                       // basicConstraints: not a CA
    seq(oid("2.5.29.15"), bool(true), octets(tlv(0x03, Buffer.from([7, 0x80])))), // keyUsage: digitalSignature
    seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))),          // extKeyUsage: serverAuth
    seq(oid("2.5.29.17"), octets(san))                                     // subjectAltName
  ));
  const serial = crypto.randomBytes(12); serial[0] = (serial[0] & 0x7f) | 0x40; // positive, no leading zero
  const tbs = seq(tlv(0xa0, int(Buffer.from([2]))), int(serial), sigAlg, name, seq(time(now), time(end)), name, spki, exts);
  const sig = crypto.sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = seq(tbs, sigAlg, bits(sig));
  const pem = "-----BEGIN CERTIFICATE-----\n" + der.toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END CERTIFICATE-----\n";
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }), expires: end.toISOString() };
}

module.exports = { makeCert };
