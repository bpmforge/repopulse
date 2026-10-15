const config = require('./config');

function paymentsClient(http) {
  return http.create({
    baseURL: 'https://payments.example.internal',
    headers: { 'X-Api-Secret': config.require('PAYMENTS_API_SECRET') },
  });
}

module.exports = { paymentsClient };
