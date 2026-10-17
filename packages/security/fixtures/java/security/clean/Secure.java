package com.example.secure;

import java.io.FileInputStream;
import java.io.InputStream;
import java.io.ObjectInputFilter;
import java.io.ObjectInputStream;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.Random;
import java.util.concurrent.ThreadLocalRandom;
import javax.net.ssl.X509TrustManager;
import javax.persistence.EntityManager;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.SAXParserFactory;

// Near-misses for the Java security baseline: the same jobs done safely, and
// the ordinary non-security uses of the same APIs.
public class Secure {
    private static final String TABLE = "users";
    private final SecureRandom secure = new SecureRandom();
    private final Random jitter = new Random();

    public void find(Connection conn, String name) throws Exception {
        PreparedStatement ps = conn.prepareStatement("SELECT * FROM " + TABLE + " WHERE name = ?");
        ps.setString(1, name);
        ps.executeQuery();
        log("SELECT is fine in a log label: " + name);
    }

    public void findJpa(EntityManager em, String owner) {
        em.createQuery("select o from Order o where o.owner = :owner")
                .setParameter("owner", owner)
                .getResultList();
    }

    public byte[] checksum(byte[] file) throws Exception {
        // Content addressing, not a secret: MD5 is fine here.
        return MessageDigest.getInstance("MD5").digest(file);
    }

    public byte[] hashPassword(String password) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(password.getBytes());
    }

    public String newSessionToken() {
        byte[] bytes = new byte[32];
        secure.nextBytes(bytes);
        return java.util.HexFormat.of().formatHex(bytes);
    }

    public long backoff(int attempt) {
        long delay = (1L << attempt) * 100 + jitter.nextInt(100);
        return delay;
    }

    public String cacheKey(String user) {
        int shard = jitter.nextInt(16);
        return user + ":" + shard;
    }

    static class Pinned implements X509TrustManager {
        private final X509TrustManager delegate;

        Pinned(X509TrustManager delegate) {
            this.delegate = delegate;
        }

        public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException {
            delegate.checkClientTrusted(chain, type);
        }

        public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException {
            delegate.checkServerTrusted(chain, type);
        }

        public X509Certificate[] getAcceptedIssuers() {
            return delegate.getAcceptedIssuers();
        }
    }

    public void ping(String host) throws Exception {
        new ProcessBuilder("ping", "-c", "1", host).start();
        Runtime.getRuntime().exec(new String[] {"ping", "-c", "1", host});
    }

    public Object readCache(String path) throws Exception {
        // The app's own cache file, not a network stream.
        try (ObjectInputStream in = new ObjectInputStream(new FileInputStream(path))) {
            return in.readObject();
        }
    }

    public Object receive(Socket socket) throws Exception {
        ObjectInputStream in = new ObjectInputStream(socket.getInputStream());
        in.setObjectInputFilter(ObjectInputFilter.Config.createFilter("com.example.Msg;!*"));
        return in.readObject();
    }

    public void parse(InputStream xml) throws Exception {
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        dbf.newDocumentBuilder().parse(xml);
    }

    public void sax(InputStream xml) throws Exception {
        SAXParserFactory spf = SAXParserFactory.newInstance();
        spf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        spf.newSAXParser();
    }

    public void wipe(char[] secretArray) {
        for (int i = 0; i < secretArray.length; i++) {
            secretArray[i] = (char) jitter.nextInt();
        }
    }

    public java.util.function.BiPredicate<String, String> always() {
        java.util.function.BiPredicate<String, String> any = (a, b) -> true;
        return any;
    }

    public void stax(InputStream xml, javax.xml.stream.XMLResolver resolver) throws Exception {
        javax.xml.stream.XMLInputFactory xif = javax.xml.stream.XMLInputFactory.newInstance();
        xif.setXMLResolver(resolver);
        xif.createXMLStreamReader(xml);
    }

    public void table(InputStream xml, java.util.Map<String, Boolean> secureFeatures) throws Exception {
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        for (java.util.Map.Entry<String, Boolean> e : secureFeatures.entrySet()) {
            dbf.setFeature(e.getKey(), e.getValue());
        }
        dbf.newDocumentBuilder().parse(xml);
    }

    public Object claims(String token, com.auth0.jwt.algorithms.Algorithm alg) {
        return com.auth0.jwt.JWT.require(alg).build().verify(token).getClaims();
    }

    private void log(String s) {}

    // Not secrets: jitter, sampling and shard choice are ordinary uses of a
    // non-cryptographic generator, and nothing here is named like a secret.
    public double backoffFraction() {
        double jitterFraction = Math.random();
        return jitterFraction;
    }

    public int pickShard(int shards) {
        int shard = ThreadLocalRandom.current().nextInt(shards);
        return shard;
    }

    public long delayMillis() {
        return (long) (java.lang.Math.random() * 250);
    }
}
