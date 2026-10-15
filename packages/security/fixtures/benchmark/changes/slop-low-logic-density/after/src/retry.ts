// ============================================================
// Retry Utilities
// ============================================================
//
// This module provides retry functionality for asynchronous
// operations. Retrying is an important technique for building
// resilient systems that can recover from transient failures.
//
// Key features:
//   - Configurable number of attempts
//   - Exponential backoff between attempts
//   - Clean, readable implementation
//
// Usage:
//   const result = await withRetry(() => fetchData(), 3);
//
// ============================================================

// Calculate the backoff delay for a given attempt number.
// The delay grows exponentially with each attempt.
export function backoffMs(attempt: number): number {
  // Return the delay in milliseconds
  return 100 * 2 ** attempt;
}

// Retry an asynchronous function up to the given number of attempts.
// If all attempts fail, the last error is thrown.
export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  // Loop through each attempt
  for (let i = 0; i < attempts - 1; i++) {
    // Try to run the function and return its result
    try {
      return await fn();
    } catch {
      // Wait before the next attempt
      await new Promise((r) => setTimeout(r, backoffMs(i)));
    }
  }
  // Final attempt: let any error propagate to the caller
  return fn();
}
