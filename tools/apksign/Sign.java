import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;

/**
 * Signs the unsigned APK that GitHub builds, with the GloryCast Cam key kept in the project files,
 * then checks the result the way a phone would.
 *
 * Usage: Sign keystore.p12 password-file alias in.apk out.apk
 */
public class Sign {
    public static void main(String[] a) throws Exception {
        if (a.length != 5) {
            System.err.println("Usage: Sign keystore.p12 password-file alias in.apk out.apk");
            System.exit(2);
        }
        char[] pw = new String(Files.readAllBytes(Paths.get(a[1])), StandardCharsets.UTF_8).trim().toCharArray();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (InputStream in = new FileInputStream(a[0])) {
            ks.load(in, pw);
        }
        PrivateKey key = (PrivateKey) ks.getKey(a[2], pw);
        X509Certificate cert = (X509Certificate) ks.getCertificate(a[2]);
        if (key == null || cert == null) throw new IllegalStateException("No key called " + a[2] + " in " + a[0]);

        ApkSigner.SignerConfig signer =
                new ApkSigner.SignerConfig.Builder("GLORYCAST", key, Collections.singletonList(cert)).build();
        new ApkSigner.Builder(Collections.singletonList(signer))
                .setInputApk(new File(a[3]))
                .setOutputApk(new File(a[4]))
                .setMinSdkVersion(24)
                // v2 only, as the Android build tools do for apps that start at Android 7.0;
                // the old v1 jar signature also needs JDK parts that newer Java removed
                .setV1SigningEnabled(false)
                .setV2SigningEnabled(true)
                .setCreatedBy("GloryCast")
                .build()
                .sign();

        ApkVerifier.Result r = new ApkVerifier.Builder(new File(a[4])).setMinCheckedPlatformVersion(24).build().verify();
        for (ApkVerifier.IssueWithParams e : r.getErrors()) System.out.println("ERROR: " + e);
        for (ApkVerifier.IssueWithParams w : r.getWarnings()) System.out.println("WARNING: " + w);
        byte[] sha = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
        StringBuilder fp = new StringBuilder();
        for (byte b : sha) fp.append(String.format("%02X", b));
        System.out.println("verified=" + r.isVerified() + " v1=" + r.isVerifiedUsingV1Scheme()
                + " v2=" + r.isVerifiedUsingV2Scheme() + " cert-sha256=" + fp);
        if (!r.isVerified() || !r.isVerifiedUsingV2Scheme()) {
            new File(a[4]).delete();
            System.exit(1);
        }
    }
}
