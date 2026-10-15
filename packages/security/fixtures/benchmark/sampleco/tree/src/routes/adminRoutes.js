const express = require("express");
const router = express.Router();
const invoiceService = require("../services/invoiceService");
// --- inline auth (duplicated across routes) ---
const { verifyToken } = require("../services/authService");
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const result = verifyToken(token);
  if (!result.ok) return res.status(401).json({ error: "unauthorized" });
  req.user = result;
  next();
}

// D9: admin route requires auth but NEVER checks req.user.role === "admin"
// Any authenticated user can list every customer's invoices.
router.get("/invoices", requireAuth, (req, res) => {
  invoiceService.findInvoicesByCustomer(req.query.customerId || "1", (e, rows) =>
    res.json(rows || []));
});

module.exports = router;
