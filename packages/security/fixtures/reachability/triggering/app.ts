import minimist from 'minimist';
import * as jwt from 'jsonwebtoken';
import ejs from 'ejs';
const serialize = require('node-serialize');

export function args(argv: string[]) {
  // ruleid: bpm-reach-npm-minimist-default
  return minimist(argv);
}

export function check(token: string, key: string) {
  // ruleid: bpm-reach-npm-jsonwebtoken-verify
  return jwt.verify(token, key);
}

export function view(file: string, data: object) {
  // ruleid: bpm-reach-npm-ejs-renderfile
  return ejs.renderFile(file, data);
}

export function revive(payload: string) {
  // ruleid: bpm-reach-npm-node-serialize-unserialize
  return serialize.unserialize(payload);
}

export function destructuredRevive(payload: string) {
  const { unserialize } = require('node-serialize');
  // ruleid: bpm-reach-npm-node-serialize-unserialize
  return unserialize(payload);
}
