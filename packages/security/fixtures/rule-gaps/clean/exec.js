// Near-misses for bpm-js-child-process-concat: execFile with an argv array,
// a promisified exec given a constant, and a promisified exec that is not
// child_process's (a database handle's).
const { exec, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const run = promisify(exec);

async function branchLog(db, branch, table) {
  const { stdout } = await runFile('git', ['log', '--oneline', '--', branch]);
  await run('git status --porcelain');
  const query = promisify(db.exec);
  await query('VACUUM ' + table);
  // A RegExp's exec with arithmetic in its argument is not a shell command
  // (16 false hits on Repo Pulse's own scanners, 2026-11-18).
  const word = /[a-z]+$/.exec(stdout.slice(0, stdout.length - 1 + 1));
  const tail = new RegExp(`^(${table})`).exec('x' + branch);
  return [stdout, word, tail];
}

module.exports = { branchLog };
