// Clean near-misses for the Java weak-cryptography pack: the same APIs, with
// the sound choice.
package demo;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Properties;
import java.util.Random;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Crypto {
  byte[] digests(byte[] data, Properties config) throws Exception {
    MessageDigest a = MessageDigest.getInstance("SHA-256");
    MessageDigest b = MessageDigest.getInstance("SHA-512", "SUN");
    MessageDigest c = java.security.MessageDigest.getInstance("sha-384");
    // An algorithm chosen by configuration is not resolved, so it is not judged.
    MessageDigest d = MessageDigest.getInstance(config.getProperty("digest", "SHA-512"));
    return a.digest(data);
  }

  void ciphers() throws Exception {
    Cipher a = Cipher.getInstance("AES/GCM/NoPadding");
    Cipher b = Cipher.getInstance("AES/CBC/PKCS5Padding");
    Cipher c = javax.crypto.Cipher.getInstance("ChaCha20-Poly1305");
    KeyGenerator d = KeyGenerator.getInstance("AES");
  }

  void handler(HttpServletRequest request, HttpServletResponse response) throws IOException {
    int a = new SecureRandom().nextInt(1000000);
    response.getWriter().println(a);
  }

  // Not a request handler: random jitter in a retry loop is an ordinary use.
  long backoffMillis(int attempt) {
    return 100L * attempt + new Random().nextInt(50);
  }
}
