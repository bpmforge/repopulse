// Triggering fixture for the injection pack (bpm-baseline.injection.v1.yaml).
// `// ruleid: <id>` names the rule that must fire on the NEXT line.
import { exec } from 'node:child_process';
import express from 'express';
import * as fs from 'node:fs';

const app = express();
declare const db: { query(sql: string, params?: unknown[]): Promise<unknown> };

app.get('/user', async (req, res) => {
  const id = req.query.id;
  // ruleid: bpm-inj-sql-js
  const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`);
  res.json(rows);
});

app.get('/search', async (req, res) => {
  const term = req.params.term;
  // ruleid: bpm-inj-sql-js
  await db.query("SELECT * FROM items WHERE name LIKE '%" + term + "%'");
  res.end();
});

app.post('/ping', (req, res) => {
  const host = req.body.host;
  // ruleid: bpm-inj-cmd-js
  exec('ping -c 1 ' + host, () => res.end());
});

app.get('/file', (req, res) => {
  const name = req.query.name as string;
  // ruleid: bpm-inj-path-js
  res.sendFile('/srv/uploads/' + name);
});

app.get('/read', (req, res) => {
  // ruleid: bpm-inj-path-js
  const data = fs.readFileSync(`./data/${req.params.file}`);
  res.json(data);
});

app.get('/hello', (req, res) => {
  // ruleid: bpm-inj-xss-js
  res.send('<h1>Hello ' + req.query.name + '</h1>');
});

app.get('/fetch', async (req, res) => {
  const target = req.query.url as string;
  // ruleid: bpm-inj-ssrf-js
  const upstream = await fetch(target);
  res.json(await upstream.json());
});

app.get('/go', (req, res) => {
  // ruleid: bpm-inj-redirect-js
  res.redirect(req.query.next as string);
});

export function render(el: HTMLElement): void {
  // ruleid: bpm-inj-dom-xss-js
  el.innerHTML = location.hash;
}
