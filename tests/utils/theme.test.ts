// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, applyTheme, readStoredTheme } from '../../src/utils/theme.ts';

describe('theme storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
  });

  it('defaults to dark when nothing is stored', () => {
    expect(readStoredTheme()).toBe('dark');
  });

  it('reads a stored light theme and falls back to dark for unknown values', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(readStoredTheme()).toBe('light');

    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readStoredTheme()).toBe('dark');
  });

  it('marks the root element for light mode and stores the choice', () => {
    applyTheme('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    applyTheme('dark');
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
