import { expect, fullyVisiblePhotoId, openTimeline, pauseTimelineFlow, test } from './fixtures';

test('opening a photo shows its EXIF details and Escape closes the lightbox', async ({ page }) => {
  await openTimeline(page);
  await pauseTimelineFlow(page);

  const photoId = await fullyVisiblePhotoId(page);
  await page.getByTestId(`timeline-photo-card-${photoId}`).click();
  await expect(page.getByTestId('photo-lightbox-modal')).toBeVisible();
  await expect(page.getByTestId('lightbox-main-image')).toBeVisible();
  await expect(page.getByTestId('lightbox-exif-section')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('photo-lightbox-modal')).toBeHidden();
});
