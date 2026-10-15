// SampleCo config
module.exports = {
  port: process.env.PORT || 3000,
  // D1: hardcoded secret committed to source (fake value)
  apiKey: "sk_live_51H8xQ2eZvKf9sampleco_DO_NOT_USE_9f3a",
  jwtSecret: "sampleco-super-secret-key",
  dbFile: "./sampleco.db"
};
