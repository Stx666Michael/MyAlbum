import type { Locator, Page } from '@playwright/test';
import { expect, openLocationView, openTimeline, test } from './fixtures';

const themeToggle = (page: Page) => page.getByTestId('theme-toggle-btn');
const isLightClassSet = (page: Page) => page.locator('html').evaluate((el) => el.classList.contains('light'));

// Averages the RGB channels of a computed color. The canvas parses whatever syntax the browser reports (rgb or oklch).
async function averageChannel(locator: Locator, property: 'backgroundColor' | 'color'): Promise<number> {
  return locator.evaluate((el, prop) => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('2d canvas is unavailable');
    ctx.fillStyle = getComputedStyle(el)[prop];
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return (r + g + b) / 3;
  }, property);
}

test.describe('light and dark theme', () => {
  const basemapButton = (page: Page, id: 'dark' | 'light' | 'voyager' | 'satellite') =>
    page.getByRole('button', { name: id, exact: true });

  test('the globe basemap follows the app theme and keeps a Voyager pick', async ({ page }) => {
    await openLocationView(page);
    await expect(basemapButton(page, 'dark')).toHaveAttribute('aria-pressed', 'true');

    await themeToggle(page).click();
    await expect(basemapButton(page, 'light')).toHaveAttribute('aria-pressed', 'true');
    await expect(basemapButton(page, 'dark')).toHaveAttribute('aria-pressed', 'false');

    await basemapButton(page, 'voyager').click();
    await themeToggle(page).click();
    await expect(basemapButton(page, 'voyager')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a saved light theme opens the globe on the light basemap', async ({ page }) => {
    await openTimeline(page);
    await themeToggle(page).click();
    await openLocationView(page);
    await expect(basemapButton(page, 'light')).toHaveAttribute('aria-pressed', 'true');
  });

  test('starts dark, and the toggle switches the whole app to light and back', async ({ page }) => {
    await openTimeline(page);
    await expect(themeToggle(page)).toHaveAttribute('data-theme', 'dark');
    expect(await isLightClassSet(page)).toBe(false);
    await expect.poll(() => averageChannel(page.locator('body'), 'backgroundColor')).toBeLessThan(40);

    await themeToggle(page).click();
    await expect(themeToggle(page)).toHaveAttribute('data-theme', 'light');
    expect(await isLightClassSet(page)).toBe(true);
    await expect.poll(() => averageChannel(page.locator('body'), 'backgroundColor')).toBeGreaterThan(200);
    await expect.poll(() => averageChannel(page.getByRole('heading', { name: 'MyAlbum' }), 'color')).toBeLessThan(40);

    await themeToggle(page).click();
    await expect(themeToggle(page)).toHaveAttribute('data-theme', 'dark');
    expect(await isLightClassSet(page)).toBe(false);
    await expect.poll(() => averageChannel(page.locator('body'), 'backgroundColor')).toBeLessThan(40);
  });

  test('keeps the chosen theme after a reload', async ({ page }) => {
    await openTimeline(page);
    await themeToggle(page).click();
    await expect(themeToggle(page)).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('myalbum-theme'))).toBe('light');

    await openTimeline(page);
    await expect(themeToggle(page)).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => averageChannel(page.locator('body'), 'backgroundColor')).toBeGreaterThan(200);
  });

  test('labels on bright accent fills stay dark in both themes', async ({ page }) => {
    await openTimeline(page);
    const activeTab = page.getByTestId('switch-to-timeline-btn');

    await expect.poll(() => averageChannel(activeTab, 'color')).toBeLessThan(40);
    await themeToggle(page).click();
    await expect(themeToggle(page)).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => averageChannel(activeTab, 'color')).toBeLessThan(40);
  });

  test('the location globe view renders on the light background', async ({ page }) => {
    await openTimeline(page);
    await themeToggle(page).click();
    await expect(themeToggle(page)).toHaveAttribute('data-theme', 'light');

    await openLocationView(page);
    await expect.poll(() => averageChannel(page.getByTestId('map-view-container'), 'backgroundColor')).toBeGreaterThan(200);
  });
});
