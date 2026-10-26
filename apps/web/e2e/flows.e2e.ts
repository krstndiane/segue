import { expect, test, type Page } from '@playwright/test';

const MORNING = new Date('2026-10-20T09:00:00+08:00'); // a Tuesday

async function onboard(page: Page, things: string[]) {
  await page.clock.setFixedTime(MORNING);
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('radio', { name: /Walking/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (const t of things) {
    await page.locator('#quick-add').fill(t);
    await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Plan my day' }).click();
  await expect(page.locator('.next')).toBeVisible();
}

test('first run: say what is on today and get a plan', async ({ page }) => {
  await page.clock.setFixedTime(MORNING);
  await page.goto('/app?sky=clear');
  await expect(page.getByRole('heading', { name: 'Plan your day around real life' })).toBeVisible();
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Plan my day' })).toBeDisabled();
  await page.locator('#quick-add').fill('Gym 1h after 5pm');
  await expect(page.locator('.quick-preview')).toContainText('After 5 PM');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Lunch 12:30' }).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ob-added li')).toHaveCount(2);

  await page.getByRole('button', { name: 'Plan my day' }).click();
  await expect(page.locator('.next-title')).toHaveText('Lunch');
  await expect(page.locator('.timeline')).toContainText('Gym');
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
});

test('adding from the timeline shows where it fits, and can be undone', async ({ page }) => {
  await onboard(page, ['Lunch 12:30']);
  await page.locator('#quick-add').fill('Call mom 20 min');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Re-route from here' });
  await expect(sheet.locator('.changes')).toContainText('Call mom');
  await sheet.getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('main')).toContainText('Call mom');

  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('main')).not.toContainText('Call mom');
});

test('swipe right marks something done', async ({ page }) => {
  await onboard(page, ['Lunch 12:30', 'Call mom 20 min after 2pm']);
  const card = page.locator('.tl-card').first();
  await expect(card).toContainText('Call mom');
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  for (let dx = 0; dx <= 160; dx += 20) await page.mouse.move(box.x + 30 + dx, box.y + box.height / 2);
  await page.mouse.up();
  await expect(page.locator('.toast')).toContainText('marked done');
  await expect(page.locator('.tally')).toContainText('1 done');
});

test('something came up keeps the next hour free', async ({ page }) => {
  await onboard(page, ['Call mom 20 min', 'Lunch 12:30']);
  await page.getByRole('button', { name: 'Re-route from here' }).click();
  const sheet = page.getByRole('dialog', { name: 'Re-route from here' });
  await expect(sheet.getByRole('button', { name: 'Use this plan' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Something came up' }).click();
  await expect(sheet.locator('.preview')).toContainText('Something came up');
  await sheet.getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('.next-title')).toHaveText('Something came up');
});

test('moving an item pins it at the new time', async ({ page }) => {
  await onboard(page, ['Lunch 12:30', 'Read 30 min after 2pm']);
  await page.locator('.tl-card', { hasText: 'Read' }).click();
  const sheet = page.getByRole('dialog', { name: 'Read' });
  await expect(sheet.getByText('Why this?')).toBeVisible();
  await sheet.locator('#move-time').fill('16:00');
  await sheet.getByRole('button', { name: 'Move here' }).click();
  const row = page.locator('.tl-card', { hasText: 'Read' });
  await expect(row).toContainText('4:00 PM');
  await expect(row).toContainText('Pinned');
});

test('settings are remembered', async ({ page }) => {
  await onboard(page, ['Lunch 12:30']);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByLabel('Day ends around').fill('23:30');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Day ends around')).toHaveValue('23:30');
});

test('something came up right before a meeting: the meeting stays and the clash is shown', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T14:40:00+08:00'));
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (const t of ['Client meeting 3pm-4pm', 'Read 2h']) {
    await page.locator('#quick-add').fill(t);
    await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Plan my day' }).click();
  await expect(page.locator('.next-title')).toHaveText('Client meeting');

  await page.getByRole('button', { name: 'Re-route from here' }).click();
  await page.getByRole('button', { name: 'Something came up' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('Overlaps Something came up');
  await expect(sheet).not.toContainText("Won't fit");
  await expect(sheet).not.toContainText('Dropped');
  await sheet.getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('.timeline')).toContainText('Client meeting');
  await expect(page.locator('.timeline')).toContainText('Overlaps Something came up');
});
