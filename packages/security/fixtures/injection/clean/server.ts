// Clean near-misses: the same sources and sinks, handled safely.
import { exec, execFile } from 'node:child_process';
import express from 'express';
import path from 'node:path';

const app = express();
declare const db: { query(sql: string, params?: unknown[]): Promise<unknown> };

app.get('/user', async (req, res) => {
  const rows = await db.query('SELECT * FROM users WHERE id = $1', [req.query.id]);
  res.json(rows);
});

app.post('/ping', (req, res) => {
  execFile('ping', ['-c', '1', String(req.body.host)], () => res.end());
});

export function listFiles(): void {
  exec('ls -la');
  /ab+c/.exec('abbc');
}

app.get('/file', (req, res) => {
  const name = path.basename(String(req.query.name));
  res.sendFile(path.join('/srv/uploads', name));
});

app.get('/hello', (req, res) => {
  res.json({ greeting: `Hello ${req.query.name}` });
  res.send(escapeHtml(String(req.query.name)));
});

app.get('/fetch', async (req, res) => {
  const id = Number(req.query.id);
  const upstream = await fetch(`https://api.internal.example/items/${id}`);
  res.json(await upstream.json());
});

app.get('/go', (_req, res) => {
  res.redirect('/dashboard');
});

export function render(el: HTMLElement): void {
  el.textContent = location.hash;
  el.innerHTML = DOMPurify.sanitize(location.hash);
}
declare function escapeHtml(s: string): string;
declare const DOMPurify: { sanitize(s: string): string };
