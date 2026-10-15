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
  return stdout;
}

module.exports = { branchLog };
