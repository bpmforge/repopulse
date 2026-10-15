// Fixture (W18-07): leftover content that every leftover rule must report.
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import domain from 'node:domain';
import request from 'request';

export const config = {
  apiKey: 'YOUR_API_KEY',
  clientSecret: '<your-client-secret>',
  baseUrl: 'https://api.example.com/v1',
  stripeKey: 'sk_live_xxxxxxxxxxxx',
  sessionSecret: process.env.SESSION_SECRET || 'changeme',
};

export const seedAdmin = { username: 'admin', password: 'admin123' };

export const banner = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';

export function load(path: string): Buffer {
  // const cached = cache.get(path);
  // if (cached) {
  //   return cached;
  // }
  const raw = new Buffer(fs.readFileSync(path, 'utf8'));
  fs.exists(path, (ok) => console.info(ok));
  const parsed = url.parse('https://api.example.com/v1/items');
  const cipher = crypto.createCipher('aes192', 'k');
  void [parsed, cipher, domain, request];
  return raw;
}
