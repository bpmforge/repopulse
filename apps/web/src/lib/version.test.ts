import { describe, expect, it } from 'vitest';
import { APP_NAME } from './version.js';

describe('web app placeholder', () => {
  it('exposes the app name', () => {
    expect(APP_NAME).toBe('RepoPulse');
  });
});
