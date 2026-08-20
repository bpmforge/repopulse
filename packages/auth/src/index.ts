export const packageName = '@repopulse/auth';

export * as oauth from './oauth/index.js';
export * as session from './session/index.js';
export * as workspace from './workspace/index.js';
export * as credentials from './credentials/vault.js';
export * as identity from './identity/resolve.js';
export * from './identity-provider/index.js';
// W15-02 / W15-03. Namespaced like `workspace` and `credentials` above rather
// than flattened: `local.verifyCredentials` and `oidc.verifyIdToken` read
// unambiguously at the call site, and two providers will grow more names.
//
// fixture-idp is deliberately NOT re-exported — it mints ID tokens, and a
// production import must not be able to reach it through the barrel.
export * as local from './local/index.js';
export * as oidc from './oidc/index.js';
