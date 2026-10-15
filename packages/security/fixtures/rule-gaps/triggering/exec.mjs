// The ESM spelling of the same alias.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const sh = promisify(exec);

export async function remove(dir) {
  await sh(`rm -rf ${dir}`);
}
