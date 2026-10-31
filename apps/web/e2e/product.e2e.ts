/**
 * Everyday use: postponing one thing without disturbing the rest, and routines
 * that repeat on chosen days. Monday 2 Nov 2026, 10 AM, Manila.
 */
import { expect, test, type Page } from '@playwright/test';

const MONDAY = new Date('2026-11-02T10:00:00+08:00');
const routines = (page: Page) => page.getByRole('region', { name: 'Routines' }).locator('.blocks');
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name, exact: true });

async function startWith(page: Page, things: string[]) {
  await page.clock.setFixedTime(MONDAY);
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const box = page.getByRole('textbox').first();
  for (const t of things) {
    await box.fill(t);
    await box.press('Enter');
  }
  await page.getByRole('button', { name: 'Plan my day' }).click();
  await expect(page.locator('.next')).toBeVisible();
}

/** Each item still to come, as "start title", whether it's the next one or further down. */
const times = (page: Page) =>
  page.locator('main').evaluate((m) => {
    const next = m.querySelector('.next');
    const first = next
      ? [`${next.querySelector('.next-time')?.textContent ?? ''} ${next.querySelector('.next-period')?.textContent ?? ''} ${next.querySelector('.next-title')?.textContent ?? ''}`.replace(/\s+/g, ' ').trim()]
      : [];
    const rest = [...m.querySelectorAll('.tl-card')].map((c) => `${c.querySelector('.tl-time')?.textContent ?? ''} ${c.querySelector('.tl-title')?.textContent ?? ''}`.replace(/\s+/g, ' ').trim());
    // badges like "Set time" show on the timeline but not on the next card
    return [...first, ...rest].map((t) => t.replace(/\s*(Set time|Calendar)$/, '')).sort();
  });

test('postpone one thing: it leaves today, nothing else moves, Undo brings it back, and it stays postponed after a reload', async ({ page }) => {
  await startWith(page, ['Read 30 min', 'Class 3:30 to 5pm', 'Groceries before 8']);
  const title = (await page.locator('.next .next-title').innerText()).trim();
  const before = (await times(page)).filter((t) => !t.includes(title));

  await page.locator('.next').getByRole('button', { name: 'Details' }).click();
  const postpone = page.getByRole('button', { name: /^(Move to tomorrow|Not today)$/ });
  const label = (await postpone.innerText()).trim();
  await postpone.click();
  await expect(page.locator('.toast')).toContainText(label === 'Move to tomorrow' ? `${title} moved to tomorrow. Nothing else changed.` : `${title} is left out today. It's back tomorrow.`);
  await expect(page.locator('main .next-title')).not.toHaveText(title);
  expect(await times(page)).toEqual(before);

  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('main')).toContainText(title);

  // Again, and this time keep it: a reload doesn't bring it back.
  await page.getByRole('button', { name: new RegExp(title) }).first().click().catch(() => undefined);
  if (!(await page.getByRole('button', { name: /^(Move to tomorrow|Not today)$/ }).isVisible())) {
    await page.locator('.next').getByRole('button', { name: 'Details' }).click();
  }
  await page.getByRole('button', { name: /^(Move to tomorrow|Not today)$/ }).click();
  await page.reload();
  await expect(page.locator('.next')).toBeVisible();
  expect((await times(page)).some((t) => t.includes(title))).toBe(false);
});

test('a routine on chosen days: planned on its days only, shown with its days, and paused or resumed with one switch', async ({ page }) => {
  await startWith(page, ['Class 3:30 to 5pm']);
  await tab(page, 'Routines').click();
  await page.getByRole('button', { name: 'Add a routine' }).click();
  await page.getByLabel('Name').fill('Morning read');
  // Every day to start with; take Saturday and Sunday off.
  await expect(page.locator('.repeat-days legend')).toContainText('Every day');
  await page.locator('.repeat-days').getByRole('button', { name: 'Sat' }).click();
  await page.locator('.repeat-days').getByRole('button', { name: 'Sun' }).click();
  await expect(page.locator('.repeat-days legend')).toContainText('Weekdays');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // It's Monday, so Segue offers to fit it into today, and waits for a yes.
  await expect(page.getByRole('dialog')).toContainText('Morning read');
  await page.getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('main')).toContainText('Morning read'); // on Today
  await tab(page, 'Routines').click();
  await expect(routines(page)).toContainText('Morning read');
  await expect(routines(page)).toContainText('Weekdays');

  // Monday: it's part of today.
  await tab(page, 'Plan').click();
  await expect(page.locator('main')).toContainText('Morning read');

  // Not on Mondays any more: Plan says no routine repeats today.
  await tab(page, 'Routines').click();
  await routines(page).getByRole('button', { name: /Morning read/ }).click();
  await page.locator('.repeat-days').getByRole('button', { name: 'Mon' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(routines(page)).toContainText('Tue, Wed, Thu, Fri');
  await tab(page, 'Plan').click();
  await expect(page.locator('main')).toContainText('None of your routines repeat today.');

  // The last day can't be switched off: a routine repeats on at least one day.
  await tab(page, 'Routines').click();
  await routines(page).getByRole('button', { name: /Morning read/ }).click();
  for (const d of ['Tue', 'Wed', 'Thu']) await page.locator('.repeat-days').getByRole('button', { name: d }).click();
  await expect(page.locator('.repeat-days').getByRole('button', { name: 'Fri' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save' }).click();

  // Pause, then resume.
  const sw = page.getByRole('checkbox', { name: 'Plan Morning read' });
  await sw.uncheck({ force: true });
  await expect(routines(page).locator('li.paused')).toContainText('Morning read');
  await sw.check({ force: true });
  await expect(routines(page).locator('li.paused')).toHaveCount(0);
  // And it all survives a reload.
  await page.reload();
  await expect(routines(page)).toContainText('Fri');
});
