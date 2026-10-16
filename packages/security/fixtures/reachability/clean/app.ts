import jwt from 'jsonwebtoken';

export function decode(token: string) {
  // decode does not verify, and no advisory names it.
  return jwt.decode(token);
}

export function minimist(argv: string[]) {
  // A local function called minimist, never imported from the package.
  return argv;
}

export const parsed = minimist(['--a']);
