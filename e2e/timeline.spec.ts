import { dayColumns, expect, openTimeline, pauseTimelineFlow, test } from './fixtures';

test.describe('timeline strings', () => {
  test.beforeEach(async ({ page }) => {
    await openTimeline(page);
  });

  test('lays out one string per day with the oldest day on the left', async ({ page }) => {
    await expect(page.getByTestId('timeline-granularity-badge')).toHaveAttribute('data-granularity', 'day');
    await expect(dayColumns(page)).toHaveCount(9);

    const keys = await dayColumns(page).evaluateAll((columns) =>
      columns.map((column) => (column.getAttribute('data-testid') ?? '').replace('timeline-day-column-', '')),
    );
    const lefts: number[] = [];
    for (const key of [...keys].sort()) {
      const box = await page.getByTestId(`timeline-day-column-${key}`).boundingBox();
      lefts.push(box?.x ?? Number.NaN);
    }
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    expect(new Set(lefts).size).toBe(lefts.length);
  });

  test('hovering the settings button expands the options bar', async ({ page }) => {
    const bar = page.getByTestId('timeline-view-options-bar');
    await expect(bar).toHaveAttribute('data-expanded', 'false');

    await page.getByTestId('timeline-settings-btn').hover();
    await expect(bar).toHaveAttribute('data-expanded', 'true');

    await page.mouse.move(5, 5);
    await expect(bar).toHaveAttribute('data-expanded', 'false');
  });

  test('zooming out merges day strings into weekly and then monthly strings', async ({ page }) => {
    await pauseTimelineFlow(page);
    const zoomOut = page.getByTestId('timeline-zoom-out');
    const badge = page.getByTestId('timeline-granularity-badge');

    for (let i = 0; i < 3; i++) {
      await zoomOut.click();
    }
    await expect(page.getByTestId('timeline-zoom-level')).toHaveText('55%');
    await expect(badge).toHaveAttribute('data-granularity', 'week');

    await zoomOut.click();
    await expect(page.getByTestId('timeline-zoom-level')).toHaveText('40%');
    await expect(badge).toHaveAttribute('data-granularity', 'month');
  });

  test('reset view restores daily strings at 100% zoom', async ({ page }) => {
    await pauseTimelineFlow(page);
    const zoomOut = page.getByTestId('timeline-zoom-out');
    for (let i = 0; i < 4; i++) {
      await zoomOut.click();
    }
    await expect(page.getByTestId('timeline-granularity-badge')).not.toHaveAttribute('data-granularity', 'day');

    await page.getByTestId('timeline-reset-view').click();
    await expect(page.getByTestId('timeline-granularity-badge')).toHaveAttribute('data-granularity', 'day');
    await expect(page.getByTestId('timeline-zoom-level')).toHaveText('100%');
  });
});
