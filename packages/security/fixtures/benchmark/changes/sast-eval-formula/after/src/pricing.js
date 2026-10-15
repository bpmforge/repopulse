function applyFormula(req, res) {
  const formula = req.body.formula;
  const value = eval(formula);
  return res.json({ value });
}

module.exports = { applyFormula };
