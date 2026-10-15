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

// D11: req.body used with no runtime validation, no typing
router.get("/", requireAuth, (req, res) => {
  invoiceService.findInvoicesByCustomer(req.query.customerId, (e, rows) =>
    res.json(rows || []));
});

// D8 continues: validateInvoice exists but is NOT called here
router.post("/", requireAuth, (req, res) => {
  invoiceService.createInvoice(req.body, (e) =>
    res.json({ created: !e }));
});

module.exports = router;
