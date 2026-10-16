const _ = require('lodash');
import other from 'not-lodash';

const local = { template: (s) => s, merge: (a) => a };

export function safe(items) {
  // Other lodash functions are not the advisories' functions.
  return _.map(items, (x) => x + 1).filter(Boolean);
}

export function notLodash(source) {
  // A different object that happens to have a template method.
  return local.template(source) + other.template(source) + local.merge({});
}

export function template(source) {
  // A local function that shares the name.
  return source;
}

export const usesLocal = template('x');

export function others() {
  const u = require('underscore');
  return u.map([1], (x) => x);
}
