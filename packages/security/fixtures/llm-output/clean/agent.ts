// Clean near-misses for the R-28 pack: the same jobs, done with validation.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import DOMPurify from 'dompurify';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { Pool } from 'pg';

const openai = new OpenAI();
const Plan = z.object({ steps: z.array(z.string()) });
const ajv = new Ajv();

export async function plan(goal: string): Promise<string[]> {
  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [] });
  // Parsed and validated in one expression.
  const data = Plan.parse(JSON.parse(completion.choices[0].message.content ?? '{}'));
  return data.steps;
}

export async function planTwoStep(goal: string): Promise<string[]> {
  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [] });
  const raw = JSON.parse(completion.choices[0].message.content ?? '{}');
  const checked = Plan.safeParse(raw);
  if (!checked.success) return [];
  return checked.data.steps;
}

export async function planWithFallback(): Promise<string[]> {
  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [] });
  let raw: unknown;
  try {
    raw = JSON.parse(completion.choices[0].message.content ?? '');
  } catch {
    raw = {};
  }
  return Plan.parse(raw).steps;
}

export async function ajvChecked(): Promise<void> {
  const validate = ajv.compile({ type: 'object', properties: { path: { type: 'string' } } });
  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [] });
  const args = JSON.parse(completion.choices[0].message.tool_calls![0]!.function.arguments);
  if (!validate(args)) throw new Error('bad tool call');
  fs.writeFileSync(path.join('/srv/notes', path.basename(args.path)), String(args.content));
}

export async function structured(goal: string): Promise<string[]> {
  // Strict structured output: the API enforced the schema.
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: goal }],
    response_format: zodResponseFormat(Plan, 'plan'),
  });
  return JSON.parse(completion.choices[0].message.content ?? '{}').steps;
}

export async function parsedHelper(goal: string): Promise<string[]> {
  const completion = await openai.chat.completions.parse({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: goal }],
    response_format: zodResponseFormat(Plan, 'plan'),
  });
  return completion.choices[0].message.parsed?.steps ?? [];
}

export async function vercelObject(goal: string): Promise<string[]> {
  const { object } = await generateObject({ model: 'openai/gpt-4o', schema: Plan, prompt: goal });
  return object.steps;
}

export async function render(el: HTMLElement): Promise<void> {
  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [] });
  el.innerHTML = DOMPurify.sanitize(completion.choices[0].message.content ?? '');
  el.textContent = completion.choices[0].message.content;
}

export async function store(pool: Pool, id: string): Promise<void> {
  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [] });
  // Model text as a bound parameter is data, not SQL.
  await pool.query('UPDATE docs SET summary = $1 WHERE id = $2', [
    completion.choices[0].message.content,
    id,
  ]);
  // Writing model text INTO a fixed file is fine.
  fs.writeFileSync('/srv/out/summary.txt', completion.choices[0].message.content ?? '');
}

export async function regexOnly(): Promise<string> {
  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [] });
  const text = completion.choices[0].message.content ?? '';
  // RegExp.prototype.exec is not child_process.exec.
  const fence = /```json([\s\S]*?)```/.exec(text);
  return fence?.[1] ?? '';
}

export function notModelOutput(cmd: string, body: string): void {
  // Untrusted, but not model output: other rules' business.
  execFile('git', ['log', cmd]);
  JSON.parse(body);
  const res = { choices: 'a,b' };
  JSON.parse(res.choices);
}
