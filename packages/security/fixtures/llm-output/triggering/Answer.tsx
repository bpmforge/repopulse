// Triggering fixture: model output rendered as raw markup in React.
import OpenAI from 'openai';

const openai = new OpenAI();

export async function Answer({ question }: { question: string }) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: question }],
  });
  const html = completion.choices[0].message.content ?? '';
  // ruleid: bpm-llm-output-injection
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
