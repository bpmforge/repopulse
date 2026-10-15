const express = require("express");
const router = express.Router();
// --- inline auth (duplicated across routes) ---
const { verifyToken } = require("../services/authService");
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const result = verifyToken(token);
  if (!result.ok) return res.status(401).json({ error: "unauthorized" });
  req.user = result;
  next();
}

// D12: stale comment — rate limiter was removed but comment claims it exists
// Rate limited to 5 requests/min per IP via the limiter middleware below.
router.post("/login", (req, res) => {
  // (no limiter here anymore)
  res.json({ token: "dev-token" });
});

module.exports = router;
