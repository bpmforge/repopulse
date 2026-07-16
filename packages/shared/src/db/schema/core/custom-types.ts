import { customType } from 'drizzle-orm/pg-core';

// drizzle-orm has no built-in `bytea` column (verified: no bytea.ts under
// pg-core/columns). Credential ciphertext/IV are opaque bytes end to end —
// callers pass/receive Buffer, never a string encoding.
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
