// A test helper against a local self-signed server: excluded by path (test/), on purpose.
const https = require('node:https');
module.exports = new https.Agent({ rejectUnauthorized: false });
