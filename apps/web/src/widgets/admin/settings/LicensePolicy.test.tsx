import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LicensePolicyPanel } from './LicensePolicy.js';
import type { LicensePolicy } from './contracts.js';

// W20-08 (UX_TODO FND-18): the license policy had no screen and no API key.

const defaults: LicensePolicy = {
  flagCategories: ['network-copyleft', 'strong-copyleft'],
  flagUnknown: true,
  allow: [],
  flag: ['AGPL-3.0'],
};

describe('LicensePolicyPanel (W20-08)', () => {
  it('saves the whole policy as one snake-case object', () => {
    const onSave = vi.fn();
    render(
      <LicensePolicyPanel
        effective={defaults}
        defaults={defaults}
        isDefaulted
        saving={false}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId('license-category-weak-copyleft'));
    fireEvent.click(screen.getByTestId('license-category-strong-copyleft'));
    fireEvent.click(screen.getByTestId('license-flag-unknown'));
    fireEvent.change(screen.getByTestId('license-allow'), { target: { value: ' MPL-2.0 \n\n' } });
    fireEvent.click(screen.getByTestId('save-license-policy'));
    expect(onSave).toHaveBeenCalledWith({
      license_policy: {
        flag_categories: ['network-copyleft', 'weak-copyleft'],
        flag_unknown: false,
        allow: ['MPL-2.0'],
        flag: ['AGPL-3.0'],
      },
    });
  });

  it('restore fills the defaults without saving', () => {
    const onSave = vi.fn();
    render(
      <LicensePolicyPanel
        effective={{ ...defaults, flag: [] }}
        defaults={defaults}
        isDefaulted={false}
        saving={false}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId('restore-license-policy'));
    expect(screen.getByTestId('license-flag')).toHaveValue('AGPL-3.0');
    expect(onSave).not.toHaveBeenCalled();
  });
});
