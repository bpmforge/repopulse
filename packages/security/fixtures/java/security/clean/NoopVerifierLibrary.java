package org.example.ssl;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLSession;

// A LIBRARY defining its no-op verifier singleton is not an application using
// one; the use site is what the rule is for.
public class NoopHostnameVerifier implements HostnameVerifier {
    public static final NoopHostnameVerifier INSTANCE = new NoopHostnameVerifier();

    @Override
    public boolean verify(String host, SSLSession session) {
        return host != null;
    }
}
