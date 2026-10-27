#!/usr/bin/env node
// The FIXTURE MODEL SERVICE for the customer-journey run (W17-30).
//
// An OpenAI-compatible endpoint with no dependencies, so it runs inside the
// demo stack's api image with plain `node`. It plays the part LM Studio plays
// in a real install: the product's Tier-2 client (packages/analysis/src/t2)
// calls `POST /v1/chat/completions` with `stream: true`, the admin "Test
// connection" button calls it non-streamed, and the worker's boot health check
// calls `GET /v1/models`. Every one of those is the SHIPPING path — this file
// replaces only the model, never the code that talks to it.
//
// WHY THE ANSWER IS DERIVED FROM THE PROMPT rather than canned. The checklist
// scanners validate every finding's `evidence_quote` against the diff they
// sent (packages/analysis/src/schema/finding.ts); a quote that is not a
// verbatim substring is REJECTED. So a canned finding would be thrown out and
// the journey would prove only that the rejection path works. Reading the
// fenced diff back out of the prompt and quoting one of its own added lines is
// what lets a fixture produce a finding the real validator accepts — which is
// the evidence that a model's answer reaches the screen.
//
// BEHAVIOUR IS SELECTED BY THE MODEL ID the product sends, because that is the
// one field an operator controls from Settings → Models without touching the
// container:
//
//   fixture-model   answers immediately with a valid findings payload
//   fixture-hang    accepts an analysis request (or a "Test connection") and
//                   never answers — the model-timeout drill; the socket stays
//                   open until the CLIENT gives up. It DOES answer the save-time
//                   capability probe's short prompts (W19-01), the way a model
//                   that worked when it was added and stalls later would;
//                   otherwise the probe's 120 s per check holds the save open
//                   for minutes and the drill never reaches a run.
//   anything else   400 "model not found", the way LM Studio answers an
//                   unloaded model id (a guessed name must fail loudly)
//
// Everything it receives is logged to stdout, one line per request, so
// `compose logs model` is the record of what the product actually sent.

import { createServer } from 'node:http';

const port = Number(process.env.FIXTURE_MODEL_PORT ?? 3399);
const KNOWN = new Set(['fixture-model', 'fixture-hang']);

function log(line) {
  process.stdout.write(`[fixture-model] ${new Date().toISOString()} ${line}\n`);
}

/**
 * One finding quoting an ADDED line from the diff in the prompt, or none.
 *
 * The chunker (packages/analysis/src/chunker) emits `--- <path>` before each
 * file's hunks and the checklist prompt fences the whole chunk in ```diff.
 * Prefers a line the fixture forge deliberately made worth flagging — a
 * string-built query — and otherwise the first substantive added line.
 */
function findingsFor(prompt) {
  const fence = /```diff\n([\s\S]*?)\n```/.exec(prompt);
  if (!fence) return [];
  const lines = fence[1].split('\n');

  let file = null;
  let newLine = 0;
  const candidates = [];
  for (const raw of lines) {
    if (raw.startsWith('--- ')) {
      file = raw.slice(4).trim();
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]) - 1;
      continue;
    }
    if (raw.startsWith('-')) continue;
    newLine += 1;
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const text = raw.slice(1).trim();
    if (text.length < 12 || file === null) continue;
    candidates.push({ file, line: newLine, text });
  }
  if (candidates.length === 0) return [];

  const preferred =
    candidates.find((c) => /select \*|\.query\(/.test(c.text)) ??
    candidates.find((c) => /catch \{/.test(c.text)) ??
    candidates[0];

  return [
    {
      dimension: 'security',
      severity: 3,
      confidence: 4,
      file: preferred.file,
      line_range: [preferred.line, preferred.line],
      title: 'Fixture model: reviewed this added line',
      evidence_quote: preferred.text,
      rationale:
        'Produced by the W17-30 fixture model from the diff it was sent. The quote is verbatim from that diff, which is what the evidence validator requires.',
      suggested_fix: null,
    },
  ];
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    log('GET /v1/models');
    json(res, 200, {
      object: 'list',
      data: [...KNOWN].map((id) => ({ id, object: 'model', owned_by: 'fixture' })),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        log('POST /v1/chat/completions -> 400 (body not JSON)');
        json(res, 400, { error: { message: 'request body is not JSON' } });
        return;
      }
      const model = String(body.model ?? '');
      const prompt = String(body.messages?.[body.messages.length - 1]?.content ?? '');
      const auth = req.headers.authorization ? 'with Authorization header' : 'no credential';

      if (!KNOWN.has(model)) {
        log(`POST /v1/chat/completions model=${JSON.stringify(model)} -> 400 model not found`);
        json(res, 400, { error: { message: `Invalid model identifier "${model}"` } });
        return;
      }

      // "Test connection" sends this prompt WITHOUT `stream`; the probe's
      // streaming check sends the same text WITH it.
      const isTestConnection = prompt === 'Reply with the single word: ok' && body.stream !== true;
      const isProbe = prompt.length < 200 && !isTestConnection;
      if (model === 'fixture-hang' && !isProbe) {
        // Never answered on purpose. The client's own deadline is what ends
        // this; when it aborts, the socket closes and the line below is logged.
        log(
          `POST /v1/chat/completions model=fixture-hang prompt=${prompt.length} chars ${auth} -> HANGING (waiting for the client to give up)`,
        );
        req.on('close', () => log('fixture-hang: client gave up and closed the connection'));
        return;
      }

      const findings = findingsFor(prompt);
      const content = JSON.stringify({ findings });
      log(
        `POST /v1/chat/completions model=fixture-model prompt=${prompt.length} chars stream=${body.stream === true} ${auth} -> 200 (${findings.length} finding${findings.length === 1 ? '' : 's'})`,
      );
      const usage = {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(content.length / 4),
        total_tokens: Math.ceil((prompt.length + content.length) / 4),
      };
      // Server-sent events when `stream: true` is asked for, as LM Studio does.
      // Since W19-01 the admin save probes the server and refuses one that
      // ignores `stream` (probe.ts: without streaming, any call over the 300 s
      // headers timeout fails), so this fixture has to stream to be added.
      // "Test connection" asks without `stream` and gets the JSON body below.
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const frame = (delta, extra = {}) =>
          `data: ${JSON.stringify({ id: `fixture-${Date.now()}`, object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, ...extra }] })}\n\n`;
        res.write(frame({ role: 'assistant', content }));
        res.write(frame({}, { finish_reason: 'stop' }));
        res.write(
          `data: ${JSON.stringify({ object: 'chat.completion.chunk', model: 'fixture-model', choices: [], usage })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      json(res, 200, {
        id: `fixture-${Date.now()}`,
        object: 'chat.completion',
        model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      });
    });
    return;
  }

  log(`${req.method} ${url.pathname} -> 404`);
  json(res, 404, { error: { message: 'not found' } });
});

// 127.0.0.1 on purpose: the product's host policy (SC-24) admits an http://
// model only on loopback or a private range, and api/worker share this
// service's network namespace in the journey overlay, so loopback IS the
// address they use.
server.listen(port, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${port} — models: ${[...KNOWN].join(', ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
