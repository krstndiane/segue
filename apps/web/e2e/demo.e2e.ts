/**
 * The guided demo at /demo: a sample day on Segue's real Today screen and
 * alternatives engine. Runs with no API (VITE_API_URL points nowhere), so it
 * also shows the demo needs no network.
 */
import { expect, test, type Page } from '@playwright/test';

const MONDAY = new Date('2026-11-02T10:00:00+08:00');
const guide = (page: Page) => page.locator('.demo-guide');
const timeline = (page: Page) => page.locator('.demo-app');

async function open(page: Page) {
  await page.clock.setFixedTime(MONDAY);
  await page.goto('/demo');
  await expect(guide(page).getByRole('heading', { level: 1 })).toHaveText('This is a planned day in Segue');
}

test('a first visit: the plan, the rain, realistic options, a choice, and Class never moves', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator('.demo-badge')).toHaveText('Demo · sample data');
  await expect(timeline(page)).toContainText('Outdoor workout');
  await expect(timeline(page)).toContainText('Ayala Triangle Gardens');
  await expect(timeline(page)).toContainText('Sample calendar');
  await expect(page.getByRole('img', { name: /broken|error/i })).toHaveCount(0);

  await guide(page).getByRole('button', { name: 'Make it rain' }).click();
  await expect(guide(page)).toContainText('It started raining');
  await expect(timeline(page)).toContainText("It's raining, and Outdoor workout is outdoors");
  await expect(page.locator('.demo-sky-text')).toContainText('Sample weather');

  await guide(page).getByRole('button', { name: 'See what Segue suggests' }).click();
  await expect(guide(page)).toContainText('(sample forecast), and Outdoor workout is outdoors');
  await expect(guide(page)).toContainText('Every option leaves time to get to Class by 3:30 PM');
  // A map of the real places, labelled as a snapshot drawn to scale.
  await expect(guide(page).locator('.minimap svg')).toBeVisible();
  await expect(guide(page).locator('.minimap')).toContainText('Sample places (OpenStreetMap snapshot)');
  const options = guide(page).locator('.alt-option');
  expect(await options.count()).toBeGreaterThanOrEqual(3);
  await expect(options.first()).toContainText(/Leaves \d+ min before Class at 3:30 PM/);

  // Not this place: it goes from the list.
  const firstTitle = (await options.first().locator('.alt-label').innerText()).trim();
  await options.first().getByRole('button', { name: 'Not this place' }).click();
  await expect(guide(page).locator('.alt-label').first()).not.toHaveText(firstTitle);

  // Choose the gym.
  const gym = guide(page).locator('.alt-option', { hasText: 'Anytime Fitness' }).first();
  await gym.getByRole('button', { name: 'Use this' }).click();
  await expect(guide(page).getByRole('heading', { level: 1 })).toHaveText('Your day, adjusted');
  await expect(guide(page)).toContainText('Class at 3:30 PM didn’t move');
  await expect(timeline(page)).toContainText('Workout');
  await expect(timeline(page)).toContainText('Anytime Fitness');
  await expect(timeline(page).locator('.tl-card', { hasText: 'Class' })).toContainText('3:30 PM');
  await expect(page.locator('.demo-stages li.on')).toContainText('You decide');

  // Undo puts the original back.
  await guide(page).getByRole('button', { name: 'Undo' }).click();
  await expect(timeline(page)).toContainText('Ayala Triangle Gardens');
  expect(errors).toEqual([]);
});

test('keeping the original plan changes nothing', async ({ page }) => {
  await open(page);
  await guide(page).getByRole('button', { name: 'Make it rain' }).click();
  await timeline(page).getByRole('button', { name: 'See options' }).click();
  await guide(page).getByRole('button', { name: 'Keep my original plan' }).click();
  await expect(guide(page).getByRole('heading', { level: 1 })).toHaveText('Your plan stays as it was');
  await expect(timeline(page)).toContainText('Ayala Triangle Gardens');
});

test('live places fall back to the sample snapshot, and say so, when the map service is unreachable', async ({ page }) => {
  await open(page);
  await guide(page).getByRole('button', { name: 'Make it rain' }).click();
  await guide(page).getByRole('button', { name: 'See what Segue suggests' }).click();
  await guide(page).getByRole('button', { name: 'Use live places near Ayala instead' }).click();
  await expect(guide(page)).toContainText("Live map data isn't available right now, so this still uses the sample snapshot.");
  expect(await guide(page).locator('.alt-option').count()).toBeGreaterThanOrEqual(3);
});

test('done, skip without reshuffling, move up only on request, and Restart puts it all back', async ({ page }) => {
  await open(page);
  // Skip the 2 PM workout: Class and Personal time keep their times.
  await page.locator('.next').getByRole('button', { name: 'Skip' }).click();
  await expect(guide(page)).toContainText('Nothing else moved');
  await expect(timeline(page).locator('.tl-card', { hasText: 'Personal time' })).toContainText('6:00 PM');
  await guide(page).getByRole('button', { name: 'Move tasks up?' }).click();
  await expect(guide(page)).toContainText(/Suggested adjustment|Nothing can start earlier/);
  await guide(page).getByRole('button', { name: /Keep current schedule|OK/ }).click();
  await expect(timeline(page).locator('.tl-card', { hasText: 'Personal time' })).toContainText('6:00 PM');
  // ✓ on Personal time.
  await timeline(page).getByRole('button', { name: 'Mark Personal time as done' }).click();
  await expect(timeline(page).locator('.finished summary')).toContainText('3 done, 1 skipped');
  // Restart: the original sample day.
  await page.getByRole('button', { name: 'Restart demo' }).click();
  await expect(timeline(page)).toContainText('Outdoor workout');
  await expect(timeline(page).locator('.finished summary')).toContainText('2 done today');
  await expect(guide(page).getByRole('heading', { level: 1 })).toHaveText('This is a planned day in Segue');
});

test('the demo works on a small phone, with nothing off screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  // Always labelled as a demo, even on the smallest screen.
  await expect(page.locator('.demo-badge')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await guide(page).getByRole('button', { name: 'Make it rain' }).click();
  await guide(page).getByRole('button', { name: 'See what Segue suggests' }).click();
  await expect(guide(page).locator('.minimap svg')).toBeVisible();
  const box = (await guide(page).locator('.minimap svg').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
});
