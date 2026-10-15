package com.example;

import javax.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

// Near-misses for the Java logging rules.
public class LoginController {
    private static final Logger log = LoggerFactory.getLogger(LoginController.class);
    private final Auth auth;

    public LoginController(Auth auth) {
        this.auth = auth;
    }

    public void login(HttpServletRequest request) {
        String user = request.getParameter("user");
        // Parameterised: the layout, not the concatenation, renders the value.
        log.info("login attempt for {}", user);
        String safe = user.replaceAll("[\r\n]", "_");
        log.info("login attempt for " + safe);
        long id = Long.parseLong(request.getParameter("id"));
        log.info("account " + id);
    }

    public void refresh(Session session) {
        int tokenCount = session.tokens().size();
        log.debug("issued {} tokens", tokenCount);
        log.info("password policy {}", session.passwordPolicy());
        log.info("secret name {}", session.secretName);
        response(session).info("token");
    }

    public void save(Account account) {
        try {
            auth.save(account);
        } catch (IllegalStateException e) {
            // Handled here: logged once, converted to a domain error.
            log.error("save failed", e);
            throw new AccountException("could not save", e);
        }
    }

    public void sync(Account account) {
        try {
            auth.sync(account);
        } catch (RuntimeException e) {
            log.warn("sync failed, marking dirty", e);
            auth.markDirty(account);
        }
    }

    private Responder response(Session s) {
        return s.responder();
    }

    public static void main(String[] args) {
        // The command line is allowed to talk.
        System.out.println("usage: login <user>");
    }

    static void printUsage() {
        System.err.println("usage: login <user>");
    }
}
