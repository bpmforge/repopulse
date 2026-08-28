import { describe, expect, it } from 'vitest';
import { noAnswerReason } from './client.js';

// A reasoning model that never answered (W16-38).
//
// The client header has always said the 45000 cap exists because "thinking
// models spend most of their budget before emitting a token of answer". What
// it did not say is what that looks like to a caller: `content` comes back
// EMPTY, and an empty string is indistinguishable from a model that answered
// "nothing".
//
// Downstream that is worse than it sounds. The OWASP runner does
// `JSON.parse(result.text)`, catches the SyntaxError, and counts the chunk as
// one rejected finding — so a model that ran out of room to answer shows up as
// a checklist that reviewed the code and found it clean. Found while chasing a
// real run: qwen3.8 on a LAN host returned `content: ""` with the substance in
// `reasoning_content`.

describe('telling "never answered" from "found nothing"', () => {
  it('is silent when the model actually answered', () => {
    expect(noAnswerReason({ message: { content: '{"findings":[]}' }, finish_reason: 'stop' })).toBeNull();
    // Even a model that ALSO reasoned: content is what matters.
    expect(
      noAnswerReason({
        message: { content: '{"findings":[]}', reasoning_content: 'let me think' },
        finish_reason: 'stop',
      }),
    ).toBeNull();
  });

  it('names the budget when reasoning ate it and the cap was hit', () => {
    const reason = noAnswerReason({
      message: { content: '', reasoning_content: 'The user is asking me to…' },
      finish_reason: 'length',
    });
    expect(reason).toMatch(/entire token budget on reasoning/);
    // ACTIONABLE, not just descriptive — the two things that fix it.
    expect(reason).toMatch(/raise the cap|non-reasoning model/);
  });

  it('distinguishes a cap hit with no reasoning at all', () => {
    const reason = noAnswerReason({ message: { content: '' }, finish_reason: 'length' });
    expect(reason).toMatch(/token cap/);
    expect(reason).not.toMatch(/reasoning/);
  });

  it('catches reasoning-without-an-answer even when the model says it stopped', () => {
    // The shape seen on a real LAN host: finish_reason 'stop', empty content,
    // everything in reasoning_content.
    expect(
      noAnswerReason({
        message: { content: '   ', reasoning_content: 'thinking…' },
        finish_reason: 'stop',
      }),
    ).toMatch(/went to reasoning_content/);
  });

  it('stays silent for an empty answer with no reasoning and no cap hit', () => {
    // Genuinely nothing to say about this one: the model returned an empty
    // string and gave no signal why. Inventing a reason would be worse than
    // letting the caller's own parse error stand.
    expect(noAnswerReason({ message: { content: '' }, finish_reason: 'stop' })).toBeNull();
    expect(noAnswerReason({})).toBeNull();
  });
});
