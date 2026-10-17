import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend<{ failOnPageErrors: void }>({
  failOnPageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await use();
      expect(errors, 'uncaught exceptions thrown by the app').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export const dayColumns = (page: Page) => page.locator('[data-testid^="timeline-day-column-"]');

export async function openTimeline(page: Page) {
  await page.goto('/');
  await expect(dayColumns(page).first()).toBeVisible({ timeout: 60_000 });
}

export async function openLocationView(page: Page) {
  await page.goto('/');
  await page.getByTestId('switch-to-location-btn').click();
  await expect(page.locator('[data-testid^="map-cluster-marker-"]').first()).toBeVisible({ timeout: 60_000 });
}

// Strings keep flowing unless paused, which makes Playwright's click stability checks wait forever
export async function pauseTimelineFlow(page: Page) {
  await page.getByTestId('timeline-settings-btn').hover();
  await expect(page.getByTestId('timeline-view-options-bar')).toHaveAttribute('data-expanded', 'true');
  const toggle = page.getByTestId('toggle-flow-btn');
  if ((await toggle.textContent())?.includes('Flowing')) {
    await toggle.click();
  }
  await expect(toggle).toHaveText(/Paused/);
}

// The timeline is panned, so the DOM-first string can sit off-screen; pick one a user could actually click
export async function fullyVisibleDayKey(page: Page): Promise<string> {
  const dayKey = await page.evaluate(() => {
    const clickable = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.left < 0 || r.right > window.innerWidth) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && el.contains(hit);
    };
    const button = Array.from(document.querySelectorAll('[data-testid^="select-day-"]')).find(clickable);
    return button?.getAttribute('data-testid')?.replace('select-day-', '') ?? null;
  });
  if (!dayKey) throw new Error('no timeline string has its select button on screen');
  return dayKey;
}

export async function fullyVisiblePhotoId(page: Page): Promise<string> {
  const photoId = await page.evaluate(() => {
    const clickable = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && el.contains(hit);
    };
    const card = Array.from(document.querySelectorAll('[data-testid^="timeline-photo-card-"]')).find(clickable);
    return card?.getAttribute('data-testid')?.replace('timeline-photo-card-', '') ?? null;
  });
  if (!photoId) throw new Error('no timeline photo card is fully on screen');
  return photoId;
}
