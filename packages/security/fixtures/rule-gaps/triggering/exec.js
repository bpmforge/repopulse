// bpm-js-child-process-concat: exec reached through a destructured,
// promisified alias (W18-17 benchmark miss), and the module object variant.
const { exec } = require('node:child_process');
const cp = require('child_process');
const util = require('node:util');

const run = util.promisify(exec);
const shell = util.promisify(cp.exec);

async function branchLog(branch) {
  const { stdout } = await run(`git log --oneline -n 20 ${branch}`);
  return stdout;
}

async function listDir(dir) {
  return shell('ls -la ' + dir);
}

module.exports = { branchLog, listDir };
