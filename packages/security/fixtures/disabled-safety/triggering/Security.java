package app;

import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.X509TrustManager;
import org.apache.http.conn.ssl.NoopHostnameVerifier;
import org.springframework.web.bind.annotation.CrossOrigin;

public class Security {
    static class TrustAll implements X509TrustManager {
        public void checkClientTrusted(X509Certificate[] chain, String authType) {}
        public void checkServerTrusted(X509Certificate[] chain, String authType) {}
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    Object verifier() {
        HttpsURLConnection.setDefaultHostnameVerifier((host, session) -> true);
        return NoopHostnameVerifier.INSTANCE;
    }

    void filterChain(HttpSecurity http) throws Exception {
        http.csrf().disable();
    }

    void filterChainLambda(HttpSecurity http) throws Exception {
        http.csrf(csrf -> csrf.disable());
    }

    void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**").allowedOriginPatterns("*").allowCredentials(true);
    }

    Process run(String file) throws Exception {
        return new ProcessBuilder("sh", "-c", "convert " + file + " out.png").start();
    }

    Process runtime(String file) throws Exception {
        return Runtime.getRuntime().exec(new String[]{"/bin/bash", "-c", "cat " + file});
    }

    @CrossOrigin(origins = "*", allowCredentials = "true")
    String endpoint() { return "ok"; }
}
