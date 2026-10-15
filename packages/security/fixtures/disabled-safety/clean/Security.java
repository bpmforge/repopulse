package app;

import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.X509TrustManager;
import org.springframework.web.bind.annotation.CrossOrigin;

public class Security {
    // A trust manager that delegates and throws: what checkServerTrusted is for.
    static class Pinned implements X509TrustManager {
        private final X509TrustManager delegate;
        Pinned(X509TrustManager delegate) { this.delegate = delegate; }
        public void checkClientTrusted(X509Certificate[] chain, String authType) {}
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            delegate.checkServerTrusted(chain, authType);
        }
        public X509Certificate[] getAcceptedIssuers() { return delegate.getAcceptedIssuers(); }
    }

    void filterChain(HttpSecurity http) throws Exception {
        http.csrf(csrf -> csrf.ignoringRequestMatchers("/webhooks/**"));
    }

    void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**").allowedOrigins("https://app.example.com").allowCredentials(true);
        registry.addMapping("/public/**").allowedOrigins("*");
    }

    Process run(String file) throws Exception {
        new ProcessBuilder("sh", "-c", "uptime | cut -d, -f1").start();
        return new ProcessBuilder("convert", file, "out.png").start();
    }

    @CrossOrigin(origins = "https://app.example.com", allowCredentials = "true")
    String endpoint() { return "ok"; }
}
