const _ = require('lodash');
const { template, defaultsDeep } = require('lodash');
const tpl = require('lodash/template');
import lo from 'lodash';
import * as ns from 'lodash';
import { merge as mergeAlias } from 'lodash';
import tplDefault from 'lodash/merge';

export function render(source, data) {
  // ruleid: bpm-reach-npm-lodash-template
  return _.template(source)(data);
}

export function destructured(source) {
  // ruleid: bpm-reach-npm-lodash-template
  return template(source);
}

export function subpath(source) {
  // ruleid: bpm-reach-npm-lodash-template
  return tpl(source);
}

export function defaultImport(source) {
  // ruleid: bpm-reach-npm-lodash-template
  return lo.template(source);
}

export function namespaceImport(a, b) {
  // ruleid: bpm-reach-npm-lodash-zipobjectdeep
  return ns.zipObjectDeep(a, b);
}

export function aliased(a, b) {
  // ruleid: bpm-reach-npm-lodash-merge
  return mergeAlias(a, b);
}

export function subpathDefault(a, b) {
  // ruleid: bpm-reach-npm-lodash-merge
  return tplDefault(a, b);
}

export function chained(source) {
  // ruleid: bpm-reach-npm-lodash-template
  return require('lodash').template(source);
}

export function deep(a, b) {
  // ruleid: bpm-reach-npm-lodash-defaultsdeep
  return defaultsDeep(a, b);
}
