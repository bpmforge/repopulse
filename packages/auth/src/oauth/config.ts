// GitHub OAuth app registration is W0-05 (human-in-loop, still open); these
// values are read from env at call time, not hardcoded, so the ticket isn't
// blocked on that registration existing yet.
export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
