const OPERATORS = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
};

function applyFormula(req, res) {
  const { left, op, right } = req.body;
  const fn = OPERATORS[op];
  if (!fn) return res.status(400).json({ error: 'unknown operator' });
  return res.json({ value: fn(Number(left), Number(right)) });
}

module.exports = { applyFormula };
