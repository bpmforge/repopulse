// slop.speculative_param and slop.orphan_flag — TRIGGERING (W18-08).
// Expected: 3 speculative_param, 2 orphan_flag.

// speculative_param 1: `retries` is never passed by either call.
function sendReport(report, retries = 3) {
  return post('/reports', report, retries);
}

// speculative_param 2 and 3: an arrow with an options object and a literal.
const formatName = (user, { short = false } = {}, separator = ' ') =>
  short ? user.first : [user.first, user.last].join(separator);

export function run(report, user) {
  sendReport(report);
  sendReport({ ...report, late: true });
  return formatName(user);
}

// orphan_flag 1: hard-coded, read once.
const ENABLE_NEW_CHECKOUT = true;

// orphan_flag 2: `_ENABLED` suffix, typed, false — the gated code is dead.
const BETA_EXPORT_ENABLED: boolean = false;

export function checkout(cart) {
  if (ENABLE_NEW_CHECKOUT) return newCheckout(cart);
  return legacyCheckout(cart);
}

export function exportMenu() {
  return BETA_EXPORT_ENABLED ? ['csv', 'xlsx'] : ['csv'];
}
