// Triggering fixture for the Java weak-cryptography pack
// (bpm-baseline.java-crypto.v1.yaml, W18-49). `// ruleid: <id>` names the rule
// that must fire on the NEXT line. Written for this repository; nothing here is
// taken from a benchmark.
package demo;

import java.io.IOException;
import java.security.MessageDigest;
import java.util.Random;
import java.util.concurrent.ThreadLocalRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Crypto {
  byte[] digests(byte[] data) throws Exception {
    // ruleid: bpm-java-weak-hash
    MessageDigest a = MessageDigest.getInstance("MD5");
    // ruleid: bpm-java-weak-hash
    MessageDigest b = MessageDigest.getInstance("SHA-1");
    // ruleid: bpm-java-weak-hash
    MessageDigest c = MessageDigest.getInstance("SHA1", "SUN");
    // ruleid: bpm-java-weak-hash
    MessageDigest d = java.security.MessageDigest.getInstance("md5");
    String name = "SHA-1";
    // ruleid: bpm-java-weak-hash
    MessageDigest e = MessageDigest.getInstance(name);
    return a.digest(data);
  }

  void ciphers() throws Exception {
    // ruleid: bpm-java-weak-cipher
    Cipher a = Cipher.getInstance("DES");
    // ruleid: bpm-java-weak-cipher
    Cipher b = Cipher.getInstance("DESede/CBC/PKCS5Padding");
    // ruleid: bpm-java-weak-cipher
    Cipher c = Cipher.getInstance("RC4");
    // ruleid: bpm-java-weak-cipher
    Cipher d = Cipher.getInstance("AES/ECB/PKCS5Padding");
    // ruleid: bpm-java-weak-cipher
    Cipher e = javax.crypto.Cipher.getInstance("DES/CBC/PKCS5Padding", "SunJCE");
    // ruleid: bpm-java-weak-cipher
    KeyGenerator f = KeyGenerator.getInstance("DES");
  }

  void handler(HttpServletRequest request, HttpServletResponse response) throws IOException {
    // ruleid: bpm-java-weak-random
    int a = new Random().nextInt(1000000);
    // ruleid: bpm-java-weak-random
    double b = Math.random();
    // ruleid: bpm-java-weak-random
    long c = ThreadLocalRandom.current().nextLong();
    // ruleid: bpm-java-weak-random
    float d = new java.util.Random().nextFloat();
    response.getWriter().println(a + b + c + d);
  }
}
