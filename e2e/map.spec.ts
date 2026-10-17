import { expect, openLocationView, test } from './fixtures';

test.describe('location globe and map', () => {
  test.beforeEach(async ({ page }) => {
    await openLocationView(page);
  });

  test('globe view groups located photos into clusters that open an inspector', async ({ page }) => {
    await expect(page.getByTestId('map-view-container')).toHaveAttribute('data-projection', 'globe');

    const cluster = page.locator('[data-testid^="map-cluster-marker-"]').first();
    await cluster.click();
    await expect(page.getByTestId('cluster-inspector-popover')).toBeVisible();
  });

  test('zooming into a cluster switches to the flat map and reveals individual photo pins', async ({ page }) => {
    const container = page.getByTestId('map-view-container');
    const pins = page.locator('[data-testid^="map-photo-marker-"]');

    await page.locator('[data-testid^="map-cluster-marker-"]').first().click();
    for (let step = 0; step < 8; step++) {
      const flatWithPins =
        (await container.getAttribute('data-projection')) === 'mercator' && (await pins.count()) > 0;
      if (flatWithPins) break;
      await page.getByTestId('map-zoom-in').click();
    }

    await expect(container).toHaveAttribute('data-projection', 'mercator');
    await expect(pins.first()).toBeVisible();
  });

  test('batch pin picker shows its banner and exits without applying anything', async ({ page }) => {
    const toggle = page.getByTestId('map-pick-location-btn');
    await toggle.click();
    await expect(page.getByTestId('map-pin-picker-banner')).toContainText('Batch Set Location');

    await toggle.click();
    await expect(page.getByTestId('map-pin-picker-banner')).toBeHidden();
  });
});
