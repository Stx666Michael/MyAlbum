import { expect, fullyVisibleDayKey, openTimeline, pauseTimelineFlow, test } from './fixtures';

test.describe('selection and batch editing', () => {
  test.beforeEach(async ({ page }) => {
    await openTimeline(page);
  });

  test('batch location opens the location tab and previews a preset without applying it', async ({ page }) => {
    const selectAll = page.getByTestId('select-all-visible-btn');
    await selectAll.click();
    await expect(selectAll).toHaveText(/^\d+ Selected$/);

    await page.getByTestId('open-batch-location-btn').click();
    const modal = page.getByTestId('batch-edit-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('loc-mode-set-btn')).toBeVisible();

    await page.getByRole('button', { name: 'Shibuya Crossing, Tokyo' }).click();
    await expect(page.getByTestId('batch-lat-input')).toHaveValue('35.6595');
    await expect(page.getByTestId('batch-lng-input')).toHaveValue('139.7004');
    await expect(page.getByTestId('batch-locname-input')).toHaveValue('Shibuya Crossing, Tokyo');

    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(selectAll).toHaveText(/^\d+ Selected$/);
  });

  test('batch time opens on the time tab', async ({ page }) => {
    await page.getByTestId('select-all-visible-btn').click();
    await page.getByTestId('open-batch-time-btn').click();

    const modal = page.getByTestId('batch-edit-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('offset-days-input')).toBeVisible();

    await page.getByTestId('close-batch-modal-btn').click();
    await expect(modal).toBeHidden();
  });

  test('selecting a day string selects its photos and clear selection resets the header', async ({ page }) => {
    await pauseTimelineFlow(page);
    const dayKey = await fullyVisibleDayKey(page);

    await page.getByTestId(`select-day-${dayKey}`).click();
    await expect(page.getByTestId('select-all-visible-btn')).toHaveText(/^\d+ Selected$/);
    await expect(page.getByTestId('open-batch-time-btn')).toBeVisible();

    await page.getByTestId('clear-selection-btn').click();
    await expect(page.getByTestId('select-all-visible-btn')).toHaveText('Select All');
  });
});
