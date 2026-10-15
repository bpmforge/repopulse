const PAYMENTS_API_SECRET = 'q8Zt3vL0pX9mR2wK7nB4yH6jD1sF5gA0';

function paymentsClient(http) {
  return http.create({
    baseURL: 'https://payments.example.internal',
    headers: { 'X-Api-Secret': PAYMENTS_API_SECRET },
  });
}

module.exports = { paymentsClient };
