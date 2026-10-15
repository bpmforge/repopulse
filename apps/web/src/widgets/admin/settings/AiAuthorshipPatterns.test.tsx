import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AiAuthorshipPatternsPanel } from './AiAuthorshipPatterns.js';

// W18-20: the admin edits the pattern list. Saved as ONE object, because the
// API's PATCH merges top-level keys only — a per-list save would reset the
// other two lists to their defaults.

const effective = {
  trailerPatterns: ['noreply@anthropic.com'],
  botLogins: ['claude[bot]'],
  branchPrefixes: ['claude/'],
};
const defaults = { ...effective, branchPrefixes: ['claude/', 'copilot/'] };

describe('AiAuthorshipPatternsPanel (W18-20)', () => {
  it('saves all three lists together, one entry per non-blank line, and keeps an emptied list empty', () => {
    const onSave = vi.fn();
    render(
      <AiAuthorshipPatternsPanel
        effective={effective}
        defaults={defaults}
        isDefaulted
        saving={false}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByTestId('ai-trailer-patterns'), {
      target: { value: ' noreply@anthropic.com \n\n@acme-agent.io' },
    });
    fireEvent.change(screen.getByTestId('ai-branch-prefixes'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('save-ai-patterns'));
    expect(onSave).toHaveBeenCalledWith({
      ai_authorship_patterns: {
        trailer_patterns: ['noreply@anthropic.com', '@acme-agent.io'],
        bot_logins: ['claude[bot]'],
        branch_prefixes: [],
      },
    });
  });

  it('restore fills the defaults without saving', () => {
    const onSave = vi.fn();
    render(
      <AiAuthorshipPatternsPanel
        effective={effective}
        defaults={defaults}
        isDefaulted={false}
        saving={false}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId('restore-ai-patterns'));
    expect(screen.getByTestId('ai-branch-prefixes')).toHaveValue('claude/\ncopilot/');
    expect(onSave).not.toHaveBeenCalled();
  });
});
