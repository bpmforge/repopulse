// V2 usage-detection fixture (W8-13).
//
// The two vulnerable PROD-DIRECT dependencies of this manifest land on
// opposite sides of the import scan on purpose: jquery is imported here and
// debug never is, so a tier that always answered "imported" and a tier that
// always answered "not imported" would each fail one half of the assertion.
// Both syntaxes appear because a scan that reads only `import` misses every
// CommonJS repository there is.
const $ = require('jquery');
import { label } from './helpers.js';

export function render(host) {
  return $(host).text(label);
}
