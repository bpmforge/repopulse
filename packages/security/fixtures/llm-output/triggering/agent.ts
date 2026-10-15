// Triggering fixture for the R-28 pack (bpm-baseline.llm-output.v1.yaml).
// `// ruleid: <id>` names the rule that must fire on the NEXT line.
import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import ollama from 'ollama';
import OpenAI from 'openai';
import { generateText } from 'ai';
import type { Pool } from 'pg';

const openai = new OpenAI();
const anthropic = new Anthropic();
const genai = new GoogleGenAI({});

export async function runShell(task: string): Promise<void> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: `Write a shell command to ${task}` }],
  });
  const command = completion.choices[0]?.message?.content ?? '';
  // ruleid: bpm-llm-output-exec
  exec(command);
}

export async function calculator(expression: string): Promise<number> {
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: `Turn into JS: ${expression}` }],
  });
  const block = res.content[0];
  const code = block && block.type === 'text' ? block.text : '';
  // ruleid: bpm-llm-output-exec
  return eval(code) as number;
}

export async function plan(goal: string): Promise<string[]> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: goal }],
  });
  // JSON mode guarantees syntax, not shape.
  // ruleid: bpm-llm-output-json-unvalidated
  const data = JSON.parse(completion.choices[0].message.content!);
  return data.steps;
}

export async function toolCall(): Promise<void> {
  const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: [] });
  const call = completion.choices[0].message.tool_calls![0]!;
  // Parsing tool-call arguments is not the JSON finding (they were generated
  // against a declared schema), but they are still model output at a sink.
  const args = JSON.parse(call.function.arguments);
  // ruleid: bpm-llm-output-injection
  fs.writeFileSync(args.path, args.content);
}

export async function textToSql(pool: Pool, question: string): Promise<unknown[]> {
  const { text } = await generateText({ model: 'openai/gpt-4o', prompt: question });
  // ruleid: bpm-llm-output-injection
  const result = await pool.query(text);
  return result.rows;
}

export async function render(el: HTMLElement, topic: string): Promise<void> {
  const response = await genai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: topic,
  });
  // ruleid: bpm-llm-output-injection
  el.innerHTML = response.text ?? '';
}

export async function localSummary(db: Pool, id: string): Promise<void> {
  const reply = await ollama.chat({ model: 'llama3', messages: [] });
  // ruleid: bpm-llm-output-injection
  await db.query(`UPDATE docs SET summary = '${reply.message.content}' WHERE id = ${id}`);
}

export async function streamed(): Promise<void> {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [],
    stream: true,
  });
  let out = '';
  for await (const chunk of stream) out += chunk.choices[0]?.delta?.content ?? '';
  // ruleid: bpm-llm-output-exec
  new Function(out)();
}
