const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

async function branchLog(branch) {
  const { stdout } = await run('git', ['log', '--oneline', '-n', '20', '--', branch]);
  return stdout.split('\n').filter(Boolean);
}

module.exports = { branchLog };
