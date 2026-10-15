package com.example;

import javax.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

// Logging constructs the Java rules must flag; each expected finding is
// announced on the line above it.
public class LoginController {
    private static final Logger log = LoggerFactory.getLogger(LoginController.class);
    private final Auth auth;

    public LoginController(Auth auth) {
        this.auth = auth;
    }

    public void login(HttpServletRequest request) {
        String user = request.getParameter("user");
        // ruleid: bpm-log-java-injection
        log.info("login attempt for " + user);
        // ruleid: bpm-log-java-stdout-in-prod
        System.out.println("login handled");
    }

    public void audit(HttpServletRequest request) {
        // ruleid: bpm-log-java-injection
        log.warn(String.format("bad agent %s", request.getHeader("User-Agent")));
    }

    public void refresh(Session session) {
        String accessToken = session.issue();
        // ruleid: bpm-log-java-secret-field
        log.debug("issued token " + accessToken);
        // ruleid: bpm-log-java-secret-field
        log.info("user {} password {}", session.user(), session.getPassword());
        // ruleid: bpm-log-java-stdout-in-prod
        System.err.printf("refreshed %s%n", session.user());
    }

    public void connect(Config config) {
        // ruleid: bpm-log-java-secret-field
        log.info("connecting with {}", config.dbPassword);
    }

    public void save(Account account) {
        // ruleid: bpm-log-java-and-rethrow
        try {
            auth.save(account);
        } catch (IllegalStateException e) {
            log.error("save failed", e);
            throw e;
        }
    }

    public void sync(Account account) {
        try {
            auth.sync(account);
        } catch (RuntimeException e) {
            // ruleid: bpm-log-java-print-stack-trace
            e.printStackTrace();
            auth.markDirty(account);
        }
    }
}
