// One error type for the whole OIDC flow, carrying a short machine code.
//
// The code exists because the callback route has to audit WHY a login failed
// (`auth.login.failure` takes a `reason`) without putting a provider's error
// prose — which may quote attacker-supplied input — into our log line.
export type OidcErrorCode =
  | 'oidc_not_configured'
  | 'oidc_discovery_failed'
  | 'oidc_discovery_invalid'
  | 'oidc_exchange_failed'
  | 'oidc_id_token_missing'
  | 'oidc_id_token_invalid'
  | 'oidc_nonce_mismatch'
  | 'oidc_subject_missing';

export class OidcError extends Error {
  readonly code: OidcErrorCode;

  constructor(code: OidcErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OidcError';
    this.code = code;
  }
}
