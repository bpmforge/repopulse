import type { Database } from '@repopulse/shared';

// Drizzle's transaction callback receives a tx object that supports the same
// insert/select/update/delete surface as the top-level db. Deriving the type
// here lets every writer accept either a `Database` or a transaction, so the
// same upsert code runs inside the per-page checkpoint transaction and in
// standalone tests. (`@repopulse/shared` doesn't export this — W2-02/03-local.)
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;
