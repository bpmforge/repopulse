// The sensitive-change radar's rules (W18-21).
//
// Every rule here was written for RepoPulse; none is derived from a registry
// pack. Each one describes a CHANGE, not a state: "this line used to check who
// you are and now does not". That is why they live in-process over diff
// patches instead of in an Opengrep pack — a pattern engine sees the tree after
// the change, and the thing these rules exist to notice is a line that is no
// longer in it.
//
// FOUR SHAPES, because "loosened" means four different things in a diff:
//
//   removed  a guard on the `-` side that the `+` side does not put back
//            (an auth middleware dropped from a route, a schema.parse deleted);
//   added    an explicit weak setting on the `+` side (verify=False, origin '*');
//   lowered  a number a safety margin depends on went DOWN (bcrypt rounds);
//   raised   a number a safety margin depends on went UP (requests per window).
//
// PRECISION OVER RECALL. A radar that cries wolf on every refactor gets muted,
// and a muted radar misses the one PR that mattered. So a removed guard whose
// name comes back elsewhere in the same file, or whose exact line reappears
// anywhere in the diff, is treated as moved, not removed — at the cost of
// missing a PR that removes a check here and adds the same check somewhere
// unrelated in the same file.

export type RadarLanguage = 'js' | 'py';
export type RadarCategory = 'authz' | 'validation' | 'crypto' | 'transport' | 'rate_limit';

export const RADAR_RULE_PROVENANCE =
  'written for RepoPulse; not derived from any registry pack' as const;

interface RuleBase {
  id: string;
  category: RadarCategory;
  /** What changed, in the words a reviewer reads first. */
  what: string;
  rationale: string;
  /** 1-3. Capped at 3 by construction: see RADAR_SEVERITY_CAP in radar.ts. */
  severity: 1 | 2 | 3;
  confidence: 1 | 2 | 3 | 4 | 5;
}

/** Group 1 of every pattern is the guard's NAME, used to recognise it coming back. */
export interface GuardPattern {
  re: RegExp;
  /**
   * Names matched under one alias are interchangeable. A `403` put back as
   * `raise PermissionDenied`, or `@validator` migrated to `@field_validator`,
   * still rejects or validates; the radar asks whether the KIND of guard
   * survived, not whether it is spelled the same.
   */
  as?: string;
  /**
   * Match the raw line, string literals included. By default strings are
   * masked first, so `'Please authenticate'` in an error message is not an
   * authentication check — but Django's MIDDLEWARE list is nothing BUT strings.
   */
  raw?: boolean;
  /**
   * Fire only when the statement itself survives without the guard. Group 1
   * is the statement's key (a field name); a removed `title: str =
   * Field(max_length=255)` with no `title` on the `+` side is a field that
   * moved or was deleted, not a constraint that was relaxed.
   */
  sameStatement?: RegExp;
}

export interface RemovedRule extends RuleBase {
  kind: 'removed';
  patterns: Partial<Record<RadarLanguage, readonly (RegExp | GuardPattern)[]>>;
}

export interface AddedRule extends RuleBase {
  kind: 'added';
  patterns: Partial<Record<RadarLanguage, readonly RegExp[]>>;
  /**
   * Patterns that only count as a weakening when the same file's removed lines
   * held something stronger — md5 is a downgrade from sha256 and a perfectly
   * good ETag on its own.
   */
  downgrades?: Partial<Record<RadarLanguage, readonly { weak: RegExp; strong: RegExp }[]>>;
}

/** Group 1 is the number. `key` pairs a removed value with its replacement. */
export interface NumericPattern {
  key: string;
  re: RegExp;
  /** Which direction loosens. Most rate-limit numbers loosen UP, windows DOWN. */
  weaker: 'lower' | 'higher';
  /** Normalises "100/minute" style values; default parses the digits. */
  value?: (m: RegExpExecArray) => number | null;
}

export interface NumericRule extends RuleBase {
  kind: 'numeric';
  patterns: Partial<Record<RadarLanguage, readonly NumericPattern[]>>;
  /**
   * Generic names like `max`, `rounds` or `iterations` mean something here only
   * when the file is about this subject; the context is required somewhere in
   * the file's patch.
   */
  context: RegExp;
}

export type RadarRule = RemovedRule | AddedRule | NumericRule;

const num = (m: RegExpExecArray): number | null => {
  const n = Number((m[1] ?? '').replace(/_/g, ''));
  return Number.isFinite(n) ? n : null;
};

const PER_HOUR: Record<string, number> = {
  s: 3600,
  sec: 3600,
  second: 3600,
  m: 60,
  min: 60,
  minute: 60,
  h: 1,
  hour: 1,
  d: 1 / 24,
  day: 1 / 24,
};

/** "5/minute", "100 per hour" → requests per hour, so 60/hour vs 5/minute compares. */
const perHour = (m: RegExpExecArray): number | null => {
  const count = Number(m[1]);
  const unit = PER_HOUR[(m[2] ?? '').toLowerCase().replace(/s$/, '')];
  return Number.isFinite(count) && unit !== undefined ? count * unit : null;
};

// ---- authorisation -----------------------------------------------------------

const JS_AUTH_NAME =
  '(?:require|ensure|check|verify|assert|enforce|must)(?:Auth\\w*|Login|LoggedIn|SignedIn|User|Admin\\w*|Role\\w*|Permission\\w*|Scope\\w*|Owner\\w*|Access\\w*|Policy|Abilit\\w*)' +
  '|is(?:Authenticated|Authorized|Authorised|Admin|Owner|LoggedIn|SignedIn)' +
  '|has(?:Role|Permission|Scope|Access|Ability)\\w*' +
  '|authenticate\\w*|authori[sz]e\\w*|ensureLoggedIn|withAuth|authGuard|\\w*AuthGuard|RolesGuard|PermissionsGuard';

const PY_AUTH_NAME =
  'is_authenticated|is_staff|is_superuser|has_perms?|has_permission|has_object_permission|check_permissions?|check_object_permissions' +
  '|require_(?:auth|login|permission|role|admin|scope|user|owner)\\w*' +
  '|ensure_\\w*(?:auth|permission|role|admin|owner|login)\\w*' +
  '|verify_\\w*(?:token|auth|permission)\\w*|get_current_\\w*user\\w*|current_active_user';

const PY_AUTH_DECORATOR =
  '[\\w.]*(?:login_required|permission_required|user_passes_test|staff_member_required|superuser_required|jwt_required|token_required|roles_required|roles_accepted|auth_required|admin_required|requires_auth\\w*|requires_permission\\w*|permission_classes|authentication_classes)';

export const AUTHZ_CHECK_REMOVED: RemovedRule = {
  id: 'sensitive.authz_check_removed',
  kind: 'removed',
  category: 'authz',
  what: 'authorization or authentication check removed',
  rationale:
    'A check that decided who may do this is gone from the diff and does not come back ' +
    'elsewhere in the file. Removals like this are the change AI reviewers most often wave ' +
    'through, because the code that remains still reads correctly.',
  severity: 3,
  confidence: 3,
  patterns: {
    js: [
      new RegExp(`\\b(${JS_AUTH_NAME})\\b`),
      // Decorator guards (NestJS, routing-controllers) whose names are too
      // generic to match anywhere but in decorator position.
      /^\s*@(Roles|Authorized|UseGuards|Auth|Permissions)\s*\(/,
      // Rejections: the response a missing check would have sent. One alias,
      // because a refactor that swaps `res.status(403)` for a thrown
      // ForbiddenError still refuses the request.
      {
        re: /\b(?:res|reply|response|ctx)\.(?:status|code|sendStatus)\(\s*(40[13])\s*\)/,
        as: 'rejection',
      },
      { re: /\bctx\.throw\(\s*(40[13])\b/, as: 'rejection' },
      { re: /\bthrow\s+new\s+(Forbidden\w*|Unauthori[sz]ed\w*)\b/, as: 'rejection' },
      { re: /\b[Hh]ttpStatus\.(FORBIDDEN|UNAUTHORIZED)\b/, as: 'rejection' },
    ],
    py: [
      new RegExp(`^\\s*@(${PY_AUTH_DECORATOR})\\b`),
      new RegExp(`\\b(${PY_AUTH_NAME})\\b`),
      /\b(?:permission_classes|authentication_classes)\s*=\s*[[(]\s*(\w+)/,
      {
        re: /\braise\s+(?:\w+\.)?(PermissionDenied|NotAuthenticated|AuthenticationFailed|Forbidden|Unauthorized)\b/,
        as: 'rejection',
      },
      // Built rather than raised: handed to a handler that raises it.
      {
        re: /(?:=|\breturn|\()\s*(?:\w+\.)?(PermissionDenied|NotAuthenticated|AuthenticationFailed)\s*\(/,
        as: 'rejection',
      },
      { re: /\babort\(\s*(40[13])\b/, as: 'rejection' },
      { re: /\b(HTTP_40[13]_\w+|HttpResponseForbidden)\b/, as: 'rejection' },
      { re: /\bstatus_code\s*=\s*(40[13])\b/, as: 'rejection' },
    ],
  },
};

export const PROTECTION_OPT_OUT_ADDED: AddedRule = {
  id: 'sensitive.protection_opt_out_added',
  kind: 'added',
  category: 'authz',
  what: 'explicit opt-out of an auth, CSRF or rate-limit check added',
  rationale:
    'The change marks existing code as exempt from a protection the rest of the app ' +
    'applies. Sometimes that is the intent (a health check, a public page); a person should ' +
    'confirm it is.',
  severity: 3,
  confidence: 3,
  patterns: {
    js: [
      /^\s*@(Public|SkipAuth|AllowAnonymous|NoAuth|SkipThrottle|Unprotected)\s*\(/,
      /\b(isPublic|skipAuth|allowAnonymous)\s*:\s*true\b/,
    ],
    py: [
      /^\s*@(csrf_exempt|permission_classes\(\s*\[\s*AllowAny|authentication_classes\(\s*\[\s*\])/,
      /\b(AllowAny)\b/,
      /\b((?:permission|authentication|throttle)_classes)\s*=\s*(?:\[\s*\]|\(\s*\))/,
      /\b(WTF_CSRF_ENABLED|CSRF_ENABLED)\s*=\s*False\b/,
    ],
  },
};

// ---- validation --------------------------------------------------------------

export const VALIDATION_REMOVED: RemovedRule = {
  id: 'sensitive.validation_removed',
  kind: 'removed',
  category: 'validation',
  what: 'input validation removed',
  rationale:
    'A schema or validator that checked incoming data is no longer called, and nothing in ' +
    'the file takes its place. Whatever it rejected now reaches the code behind it.',
  severity: 2,
  confidence: 3,
  patterns: {
    js: [
      /\b(\w*(?:Schema|schema|Validator|validator))\.(?:parse|safeParse|parseAsync|safeParseAsync|validate|validateAsync|validateSync|assert)\(/,
      /\b(validate[A-Z]\w*|validate|celebrate|checkSchema|validationResult|zValidator|ValidationPipe)\(/,
      /^\s*@(Is[A-Z]\w*|Min|Max|MinLength|MaxLength|Length|Matches|ValidateNested|ArrayMaxSize|ArrayMinSize)\(/,
      {
        re: /\bz\.\w+\([^)]*\)[^;]*\.(min|max|length|regex|email|url|uuid|int|positive|nonnegative)\(/,
        sameStatement: /^\s*(\w+)\s*:/,
      },
      /\bschema\s*:\s*\{\s*(body|querystring|params|headers)\s*:/,
    ],
    py: [
      /\.(is_valid)\(/,
      /\b(\w*[Ss]chema\w*)\(\)\.(?:load|validate)\(/,
      /\b(jsonschema\.validate|validate_json|validate)\(/,
      // pydantic v1 → v2 renamed every one of these; a migration is not a removal.
      { re: /^\s*@(field_validator|validator|model_validator|root_validator)\b/, as: 'validator' },
      { re: /\b\w+\.(model_validate|parse_obj|parse_raw)\(/, as: 'model_parse' },
      {
        re: /\bField\([^)]*\b(max_length|min_length|ge|le|gt|lt|regex|pattern)\s*=/,
        sameStatement: /^\s*(\w+)\s*:/,
      },
      /\b(con(?:str|int|list|float))\(/,
    ],
  },
};

export const VALIDATION_RELAXED: AddedRule = {
  id: 'sensitive.validation_relaxed',
  kind: 'added',
  category: 'validation',
  what: 'validation relaxed to accept unknown fields',
  rationale:
    'The schema now lets through fields it used to strip or reject. Mass-assignment bugs ' +
    'start here: the next handler to spread the body into a model inherits whatever an ' +
    'attacker adds.',
  severity: 2,
  confidence: 3,
  patterns: {
    js: [
      /\.(passthrough|nonstrict)\(\s*\)/,
      /\b(additionalProperties)\s*:\s*true\b/,
      /\b(whitelist|forbidNonWhitelisted|forbidUnknownValues)\s*:\s*false\b/,
      /\b(skipMissingProperties|allowUnknown)\s*:\s*true\b/,
    ],
    py: [
      /\b(extra)\s*=\s*(?:['"]allow['"]|Extra\.allow)/,
      /\b(unknown)\s*=\s*INCLUDE\b/,
      /['"](additionalProperties)['"]\s*:\s*True\b/,
    ],
  },
};

// ---- crypto ------------------------------------------------------------------

// Deliberately no bare "token" or "cost": an LLM pricing file has both, and a
// cost going from 3 to 2 there is a price cut, not a weaker hash.
const CRYPTO_CONTEXT =
  /bcrypt|argon|scrypt|pbkdf|crypt|hash|cipher|salt|kdf|\brsa\b|ecdsa|keypair|randomBytes|urandom|token_(?:hex|bytes|urlsafe)/i;

export const CRYPTO_PARAMETER_LOWERED: NumericRule = {
  id: 'sensitive.crypto_parameter_lowered',
  kind: 'numeric',
  category: 'crypto',
  what: 'cryptographic work factor or key size lowered',
  rationale:
    'A cost factor, iteration count, key size or token length went down. Each step down is ' +
    'a cheaper brute force for anyone holding the hashes or ciphertext.',
  severity: 3,
  confidence: 4,
  context: CRYPTO_CONTEXT,
  patterns: {
    js: [
      {
        key: 'rounds',
        re: /\b(?:saltRounds|SALT_ROUNDS|BCRYPT_ROUNDS|bcryptRounds|BCRYPT_COST|rounds|cost)\s*[:=]\s*(\d+)/,
        weaker: 'lower',
      },
      { key: 'rounds', re: /\bgenSalt(?:Sync)?\(\s*(\d+)/, weaker: 'lower' },
      { key: 'rounds', re: /\bbcrypt\.hash(?:Sync)?\([^,]+,\s*(\d+)\s*\)/, weaker: 'lower' },
      {
        key: 'iterations',
        re: /\b(?:iterations|ITERATIONS|PBKDF2_ITERATIONS|iterationCount)\s*[:=]\s*([\d_]+)/,
        weaker: 'lower',
      },
      { key: 'iterations', re: /\bpbkdf2(?:Sync)?\([^,]+,[^,]+,\s*([\d_]+)\s*,/, weaker: 'lower' },
      {
        key: 'keysize',
        re: /\b(?:modulusLength|keySize|KEY_SIZE|keyLength|keylen)\s*[:=]\s*(\d+)/,
        weaker: 'lower',
      },
      { key: 'entropy', re: /\brandomBytes\(\s*(\d+)\s*[,)]/, weaker: 'lower' },
    ],
    py: [
      {
        key: 'rounds',
        re: /\b(?:BCRYPT_LOG_ROUNDS|BCRYPT_ROUNDS|SALT_ROUNDS|log_rounds|rounds)\s*=\s*(\d+)/,
        weaker: 'lower',
      },
      { key: 'rounds', re: /\bgensalt\(\s*(\d+)\s*\)/, weaker: 'lower' },
      {
        key: 'iterations',
        re: /\b(?:iterations|ITERATIONS|PBKDF2_ITERATIONS|iteration_count)\s*=\s*([\d_]+)/,
        weaker: 'lower',
      },
      {
        key: 'iterations',
        re: /\bpbkdf2_hmac\([^,]+,[^,]+,[^,]+,\s*([\d_]+)\s*[,)]/,
        weaker: 'lower',
      },
      {
        key: 'keysize',
        re: /\b(?:key_size|KEY_SIZE|key_length|bits)\s*=\s*(\d+)/,
        weaker: 'lower',
      },
      {
        key: 'entropy',
        re: /\b(?:token_(?:hex|bytes|urlsafe)|urandom)\(\s*(\d+)\s*\)/,
        weaker: 'lower',
      },
    ],
  },
};

const STRONG_HASH = /sha-?(?:256|384|512)|sha3|blake2|argon2|bcrypt|scrypt/i;

export const CRYPTO_ALGORITHM_WEAKENED: AddedRule = {
  id: 'sensitive.crypto_algorithm_weakened',
  kind: 'added',
  category: 'crypto',
  what: 'weaker cryptographic algorithm or mode introduced',
  rationale:
    'The change moves to an algorithm or mode with known practical weaknesses, or switches ' +
    'off a check a token library performs by default.',
  severity: 3,
  confidence: 3,
  patterns: {
    js: [
      /\bcreateCipheriv?\(\s*['"`]([^'"`]*(?:ecb|des|rc4|rc2)[^'"`]*)['"`]/i,
      /\balgorithms?\s*:\s*\[?\s*['"`](none)['"`]/i,
      /\b(ignoreExpiration|ignoreNotBefore)\s*:\s*true\b/,
    ],
    py: [
      /\b(MODE_ECB)\b/,
      /\b(DES|DES3|ARC4|Blowfish)\.new\(/,
      /\balgorithms\s*=\s*\[\s*['"](none)['"]/i,
      /['"](verify_signature|verify_exp|verify_aud)['"]\s*:\s*False\b/,
      /\bjwt\.decode\([^)]*\b(verify)\s*=\s*False\b/,
    ],
  },
  downgrades: {
    js: [{ weak: /\bcreateHash\(\s*['"`](md5|sha1|md4)['"`]/i, strong: STRONG_HASH }],
    py: [{ weak: /\bhashlib\.(md5|sha1)\(/, strong: STRONG_HASH }],
  },
};

export const SIGNATURE_CHECK_REMOVED: RemovedRule = {
  id: 'sensitive.signature_check_removed',
  kind: 'removed',
  category: 'crypto',
  what: 'token or signature verification removed',
  rationale:
    'A call that verified a token, signature or webhook payload is gone and nothing in the ' +
    'file replaces it. Unverified input that still looks authenticated is the worst kind.',
  severity: 3,
  confidence: 3,
  patterns: {
    js: [
      /\b(jwt\.verify|jwtVerify|verifyJwt|verifyToken|verifyIdToken|verifyAccessToken|verifySignature|verifyWebhook\w*|timingSafeEqual|constructEvent)\(/,
    ],
    py: [
      /\b(hmac\.compare_digest|compare_digest|verify_signature|verify_webhook\w*|verify_token|verify_jwt\w*|verify_id_token|jwt\.decode|construct_event|validate_signature)\(/,
    ],
  },
};

// ---- CORS / TLS --------------------------------------------------------------

export const TLS_SETTINGS_WEAKENED: AddedRule = {
  id: 'sensitive.tls_settings_weakened',
  kind: 'added',
  category: 'transport',
  what: 'TLS verification or transport security switched off',
  rationale:
    'Certificate checking, HTTPS enforcement or a secure-cookie flag is turned off. Each is ' +
    'usually a debugging step that was meant to be temporary.',
  severity: 3,
  confidence: 4,
  patterns: {
    js: [
      /\b(rejectUnauthorized)\s*:\s*false\b/,
      /\b(NODE_TLS_REJECT_UNAUTHORIZED)\b\s*\]?\s*=\s*['"`]?0/,
      /\b(strictSSL)\s*:\s*false\b/,
      /\b(minVersion)\s*:\s*['"`]TLSv1(?:\.1)?['"`]/,
      /\b(hsts|httpOnly)\s*:\s*false\b/,
      // `secure: false` alone is also how nodemailer says STARTTLS on port 587;
      // only a cookie on the same line makes it a cookie flag.
      /\bcookie\b.*\b(secure)\s*:\s*false\b/i,
    ],
    py: [
      /\b(verify)\s*=\s*False\b/,
      /\b(_create_unverified_context)\b/,
      /\b(CERT_NONE)\b/,
      /\b(check_hostname)\s*=\s*False\b/,
      /\b(PROTOCOL_TLSv1|PROTOCOL_SSLv\d)\b/,
      /\b(SECURE_SSL_REDIRECT|SESSION_COOKIE_SECURE|CSRF_COOKIE_SECURE|SESSION_COOKIE_HTTPONLY)\s*=\s*False\b/,
      /\b(SECURE_HSTS_SECONDS)\s*=\s*0\b/,
    ],
  },
};

export const CORS_WIDENED: AddedRule = {
  id: 'sensitive.cors_widened',
  kind: 'added',
  category: 'transport',
  what: 'CORS widened to any origin',
  rationale:
    'Any website can now make requests to these endpoints from a visitor’s browser. With ' +
    'credentials allowed, that includes requests carrying the visitor’s session.',
  severity: 3,
  confidence: 4,
  patterns: {
    js: [
      /\b(origin)\s*:\s*(?:['"`]\*['"`]|true\b)/,
      /['"`](Access-Control-Allow-Origin)['"`]\s*,\s*['"`]\*['"`]/i,
      /\b(cors)\(\s*\)/,
    ],
    py: [
      /\b(CORS_ALLOW_ALL_ORIGINS|CORS_ORIGIN_ALLOW_ALL)\s*=\s*True\b/,
      /\b(allow_origins|origins)\s*=\s*(?:\[\s*)?['"]\*['"]/,
      /\b(allow_origin_regex)\s*=\s*['"]\.\*['"]/,
      /['"](Access-Control-Allow-Origin)['"]\]?\s*[,=]\s*['"]\*['"]/,
    ],
  },
};

export const PROTECTION_MIDDLEWARE_REMOVED: RemovedRule = {
  id: 'sensitive.protection_middleware_removed',
  kind: 'removed',
  category: 'transport',
  what: 'security headers or CSRF protection removed',
  rationale:
    'Middleware that set security headers (HSTS, frame and content-type protection) or ' +
    'checked CSRF tokens is no longer installed.',
  severity: 3,
  confidence: 3,
  patterns: {
    // Installation sites only: a call, or a name handed to `.use(`. The bare
    // word turns up in lists of names and in prose.
    js: [
      /\b(helmet|csurf|csrf|lusca|hsts|frameguard|doubleCsrf\w*)\s*\(/,
      /\.use\(\s*(\w*[cC]srf\w*|helmet\w*)\b/,
    ],
    py: [
      {
        re: /\b(CsrfViewMiddleware|SecurityMiddleware|XFrameOptionsMiddleware|CSRFProtect|Talisman)\b/,
        raw: true,
      },
      /^\s*@(csrf_protect)\b/,
    ],
  },
};

// ---- rate limits -------------------------------------------------------------

export const RATE_LIMIT_REMOVED: RemovedRule = {
  id: 'sensitive.rate_limit_removed',
  kind: 'removed',
  category: 'rate_limit',
  what: 'rate limit removed',
  rationale:
    'A limiter that capped how often this could be called is gone. On a login, signup or ' +
    'reset endpoint that is the difference between a lockout and a credential-stuffing run.',
  severity: 2,
  confidence: 3,
  patterns: {
    js: [/\b(\w*[rR]ate[lL]imit\w*|\w+Limiter|limiter|slowDown|Throttle\w*|ThrottlerGuard)\b/],
    py: [
      /^\s*@([\w.]*limiter\.limit|ratelimit|rate_limit\w*|throttle\w*)\b/,
      /\b(throttle_classes|RateLimiter)\b/,
    ],
  },
};

const RATE_CONTEXT = /rate.?limit|throttl|limiter|slowDown/i;

export const RATE_LIMIT_RAISED: NumericRule = {
  id: 'sensitive.rate_limit_raised',
  kind: 'numeric',
  category: 'rate_limit',
  what: 'rate limit loosened',
  rationale:
    'The limiter now allows more requests, or counts them over a shorter window. Worth a ' +
    'look when the endpoint is one an attacker would want to call many times.',
  severity: 2,
  confidence: 3,
  context: RATE_CONTEXT,
  patterns: {
    js: [
      { key: 'max', re: /\b(?:max|limit|points|requests)\s*:\s*([\d_]+)\b/, weaker: 'higher' },
      { key: 'window', re: /\b(?:windowMs|duration|ttl)\s*:\s*([\d_]+)\b/, weaker: 'lower' },
    ],
    py: [
      {
        key: 'rate',
        re: /['"](\d+)\s*(?:\/|\s+per\s+)\s*(s|sec|second|m|min|minute|h|hour|d|day)s?['"]/i,
        weaker: 'higher',
        value: perHour,
      },
    ],
  },
};

export const RADAR_RULES: readonly RadarRule[] = [
  AUTHZ_CHECK_REMOVED,
  PROTECTION_OPT_OUT_ADDED,
  VALIDATION_REMOVED,
  VALIDATION_RELAXED,
  CRYPTO_PARAMETER_LOWERED,
  CRYPTO_ALGORITHM_WEAKENED,
  SIGNATURE_CHECK_REMOVED,
  TLS_SETTINGS_WEAKENED,
  CORS_WIDENED,
  PROTECTION_MIDDLEWARE_REMOVED,
  RATE_LIMIT_REMOVED,
  RATE_LIMIT_RAISED,
];

export { num as parseRadarNumber };
