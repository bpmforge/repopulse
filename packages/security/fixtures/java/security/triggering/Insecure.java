package com.example.insecure;

import com.auth0.jwt.JWT;
import java.io.InputStream;
import java.io.ObjectInputStream;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.sql.Connection;
import java.sql.Statement;
import java.util.Random;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLSession;
import javax.net.ssl.X509TrustManager;
import javax.persistence.EntityManager;
import javax.servlet.http.HttpServletRequest;
import javax.xml.parsers.DocumentBuilderFactory;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.http.conn.ssl.NoopHostnameVerifier;

// Seeded defects for the Java security baseline; each expected finding is
// announced on the line above it.
public class Insecure {
    private final Random random = new Random();

    public void find(Connection conn, String name) throws Exception {
        Statement stmt = conn.createStatement();
        // ruleid: bpm-java-sql-string-concat
        stmt.executeQuery("SELECT * FROM users WHERE name = '" + name + "'");
    }

    public void findJpa(EntityManager em, String owner) {
        String q = "select o from Order o where o.owner = '" + owner + "'";
        // ruleid: bpm-java-sql-string-concat
        em.createQuery(q).getResultList();
        // ruleid: bpm-java-sql-string-concat
        em.createNativeQuery(String.format("delete from orders where id = %s", owner)).executeUpdate();
    }

    public byte[] hashPassword(String password) throws Exception {
        // ruleid: bpm-java-weak-hash-secret
        MessageDigest md = MessageDigest.getInstance("MD5");
        return md.digest(password.getBytes());
    }

    public String legacy(String userPassword) {
        // ruleid: bpm-java-weak-hash-secret
        return DigestUtils.sha1Hex(userPassword);
    }

    public String newSessionToken() {
        // ruleid: bpm-java-insecure-random-token
        long sessionToken = random.nextLong();
        return Long.toHexString(sessionToken);
    }

    public String generateResetCode() {
        // ruleid: bpm-java-insecure-random-token
        return String.valueOf(new Random().nextInt(999999));
    }

    static class TrustEverything implements X509TrustManager {
        public void checkClientTrusted(X509Certificate[] chain, String type) {}

        // ruleid: bpm-java-trust-all-certificates
        public void checkServerTrusted(X509Certificate[] chain, String type) {}

        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    // ruleid: bpm-java-hostname-verification-disabled
    public HostnameVerifier verifier() {
        return (host, session) -> true;
    }

    public void install(javax.net.ssl.HttpsURLConnection conn) {
        // ruleid: bpm-java-hostname-verification-disabled
        conn.setHostnameVerifier((host, session) -> true);
    }

    public Object client() {
        // ruleid: bpm-java-hostname-verification-disabled
        return NoopHostnameVerifier.INSTANCE;
    }

    static class AnyHost implements HostnameVerifier {
        // ruleid: bpm-java-hostname-verification-disabled
        public boolean verify(String host, SSLSession session) { return true; }
    }

    public void ping(String host) throws Exception {
        // ruleid: bpm-java-command-concat
        Runtime.getRuntime().exec("ping -c 1 " + host);
        // ruleid: bpm-java-command-concat
        new ProcessBuilder("sh", "-c", "nslookup " + host).start();
    }

    public Object receive(HttpServletRequest request) throws Exception {
        // ruleid: bpm-java-unsafe-deserialization
        ObjectInputStream in = new ObjectInputStream(request.getInputStream());
        return in.readObject();
    }

    public Object receive(Socket socket) throws Exception {
        InputStream raw = socket.getInputStream();
        // ruleid: bpm-java-unsafe-deserialization
        return new ObjectInputStream(raw).readObject();
    }

    public void parse(InputStream xml) throws Exception {
        // ruleid: bpm-java-xxe-parser
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setNamespaceAware(true);
        dbf.newDocumentBuilder().parse(xml);
    }

    public Object claims(String token) {
        // ruleid: bpm-java-jwt-unverified
        return JWT.decode(token).getClaims();
    }

    public Object jjwt(String token) {
        // ruleid: bpm-java-jwt-unverified
        return io.jsonwebtoken.Jwts.parser().build().parseClaimsJwt(token).getBody();
    }
}
