import { expect, openLocationView, test } from './fixtures';

test.describe('auto-locate review and apply', () => {
  test.beforeEach(async ({ page }) => {
    const reset = await page.request.post('/api/demo', { data: { reset: true } });
    expect(reset.ok()).toBeTruthy();
    await openLocationView(page);
  });

  test.afterEach(async ({ page }) => {
    const reset = await page.request.post('/api/demo', { data: { reset: true } });
    expect(reset.ok()).toBeTruthy();
  });

  test('reviews sample-track suggestions and applies only the selected matches', async ({ page }) => {
    const unlocatedToggle = page.getByTestId('toggle-unlocated-drawer-btn');
    await expect(unlocatedToggle).toBeVisible();
    const beforeCount = Number((await unlocatedToggle.innerText()).match(/\d+/)?.[0]);

    await unlocatedToggle.click();
    await page.getByTestId('unlocated-photos-drawer').getByTestId('auto-locate-unlocated-btn').click();
    const modal = page.getByTestId('auto-locate-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('auto-locate-nominatim')).not.toBeChecked();

    await page.getByTestId('auto-locate-run-btn').click();
    await expect(page.getByTestId('auto-locate-results')).toBeVisible();
    const rows = page.locator('[data-testid^="auto-locate-row-"]');
    await expect(rows.filter({ hasText: 'IMG_1013_Shibuya_Scramble_Umbrellas.jpg' })).toContainText('Companion');

    await page.getByTestId('auto-locate-sample-btn').click();
    await page.getByTestId('auto-locate-run-btn').click();
    await expect(page.getByTestId('auto-locate-results')).toBeVisible();

    await expect(rows).toHaveCount(5);
    await expect(rows.filter({ hasText: 'IMG_1014_Shibuya_Sky_Rooftop_Walk.jpg' })).toContainText('Track');
    await expect(rows.filter({ hasText: 'IMG_1015_Harajuku_Takeshita_Crepes.jpg' })).toContainText('Track');
    await expect(page.getByTestId('auto-locate-unmatched')).toContainText('IMG_9001.jpg');

    const apply = page.getByTestId('auto-locate-apply-btn');
    await expect(apply).toContainText('Apply selected (5)');
    await apply.click();
    await expect(modal).toBeHidden();
    await expect(page.getByTestId('toast-notification')).toContainText('Auto-located 5 photos');
    await expect(unlocatedToggle).toContainText(`${beforeCount - 5} Unlocated`);
  });
});
