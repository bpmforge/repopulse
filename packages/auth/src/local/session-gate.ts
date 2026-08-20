// The forced-password-change gate (W15-02, acceptance 2).
//
// WHERE THE GATE LIVES, AND WHY IT LIVES THERE.
//
// The obvious implementation is a preHandler on /api/v1 that checks
// `user.must_change_password` and rejects. That is a gate you can forget to
// wire: it lives in one file, every other route trusts it, and the day someone
// mounts a route outside that scope the gate silently stops applying to it.
//
// So the gate is not a check at all — it is the SHAPE OF THE SESSION. The whole
// application already agrees on one invariant: `session.userId` set means
// authenticated, absent means 401 (apps/api/src/plugins/api-v1.ts). A user who
// must change their password is therefore given a session that does NOT carry
// `userId`; it carries this key instead. Every guarded route in the product
// rejects them with no code aware that this feature exists, and the only
// endpoint that reads this key is the one that changes the password, which
// promotes the session to a real one on success.
//
// The cost is that such a session gets a bare 401 from /me, which tells the SPA
// nothing about why — hence the pending-status endpoint in the API route
// module. That is the trade: a slightly chattier client, and a gate that cannot
// be bypassed by adding a route.
declare module 'fastify' {
  interface Session {
    /**
     * Set INSTEAD OF `userId` for a session that has proved its password but
     * must replace it. Never set alongside `userId` — the two together would
     * mean "authenticated and also not", and every reader would pick one.
     */
    pendingPasswordChangeUserId?: number;
  }
}

export {};
