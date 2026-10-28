import { expect, test, type Page } from '@playwright/test';

const MORNING = new Date('2026-10-20T09:00:00+08:00'); // a Tuesday
const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

/** Stand-ins for Google's sign-in script and the Calendar API. */
async function fakeGoogle(page: Page) {
  await page.route('https://accounts.google.com/gsi/client', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `window.google = { accounts: { oauth2: {
        initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'fake', expires_in: 3600 }), 50) }),
        hasGrantedAllScopes: () => true, revoke: () => {} } } };`,
    }),
  );
  await page.route('https://www.googleapis.com/oauth2/v3/userinfo', (r) =>
    r.fulfill({ headers: cors, body: JSON.stringify({ sub: '42', name: 'Ana Reyes', email: 'ana@example.com' }) }),
  );
  await page.route('https://www.googleapis.com/calendar/v3/users/me/calendarList**', (r) =>
    r.fulfill({ headers: cors, body: JSON.stringify({ items: [{ id: 'me@x', primary: true, selected: true }, { id: 'team@x', selected: true }] }) }),
  );
  await page.route('https://www.googleapis.com/calendar/v3/calendars/**', (r) => {
    const standup = { iCalUID: 'standup@x', summary: 'Team standup', location: 'Zoom', start: { dateTime: '2026-10-20T10:00:00+08:00' }, end: { dateTime: '2026-10-20T10:30:00+08:00' } };
    const items = r.request().url().includes('team%40x')
      ? [{ id: 't1', ...standup }]
      : [
          { id: 'p1', ...standup },
          { id: 'p2', summary: 'Dentist', start: { dateTime: '2026-10-20T15:00:00+08:00' }, end: { dateTime: '2026-10-20T16:00:00+08:00' } },
          { id: 'p3', summary: 'Ana birthday', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } },
        ];
    return r.fulfill({ headers: cors, body: JSON.stringify({ items }) });
  });
}

async function onboard(page: Page, things: string[]) {
  await page.clock.setFixedTime(MORNING);
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (const t of things) {
    await page.locator('#quick-add').fill(t);
    await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Plan my day' }).click();
  await expect(page.locator('.next')).toBeVisible();
}

test('the landing page explains Segue and opens the app', async ({ page }) => {
  // "before 8" means 8 PM in the morning and 8 AM before dawn, so fix the clock.
  await page.clock.setFixedTime(MORNING);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Re-route your day in one tap');
  await page.locator('#lp-try').fill('Groceries before 8');
  await expect(page.locator('.lp-try-result')).toContainText('Before 8 PM');
  await page.getByRole('button', { name: 'Storm' }).click();
  await expect(page.locator('.lp-phone')).toContainText("It's raining");
  await page.getByRole('link', { name: 'Try it without signing up' }).first().click();
  await expect(page).toHaveURL(/\/app(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Plan your day around real life' })).toBeVisible();
});

test('plan my day: leave a routine out for today only', async ({ page }) => {
  await onboard(page, ['Lunch 12:30', 'Stretch 20 min every day']);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/plan(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Plan your day' })).toBeVisible();
  await page.getByText("What's in today").click();
  await page.getByText('Include Stretch today').locator('..').locator('.track').click();
  await page.getByRole('button', { name: 'Re-plan my day' }).click();
  await page.getByRole('dialog', { name: 'Re-route from here' }).getByRole('button', { name: 'Use this plan' }).click();
  await expect(page).toHaveURL(/\/app(\?|$)/);
  await expect(page.locator('main')).not.toContainText('Stretch');
  await page.getByRole('button', { name: 'Routines' }).click();
  await expect(page.locator('main')).toContainText('Stretch'); // still a routine, back tomorrow
});

test('connect Google Calendar, leave one event out, and plan around the rest', async ({ page }) => {
  await fakeGoogle(page);
  await onboard(page, ['Lunch 12:30']);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.locator('.hours-panel').getByRole('button', { name: 'Connect calendar' }).click();
  await expect(page).toHaveURL(/\/app\/calendar(\?|$)/);
  await expect(page.getByText('Reads, never writes')).toBeVisible();

  await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
  const events = page.locator('.event-list li');
  await expect(events).toHaveCount(2); // the standup is on two calendars; the birthday is all-day
  await events.filter({ hasText: 'Dentist' }).locator('.track').click();
  await expect(events.filter({ hasText: 'Dentist' })).toContainText("Left out of today's plan");

  await page.getByRole('button', { name: 'Plan my day around it' }).click();
  await page.getByRole('button', { name: 'Re-plan my day' }).click();
  await page.getByRole('dialog', { name: 'Re-route from here' }).getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('main')).toContainText('Team standup');
  await expect(page.locator('main')).not.toContainText('Dentist');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Manage Google Calendar' })).toBeVisible();
});

test('hour by hour: tap an hour to add something then', async ({ page }) => {
  await onboard(page, ['Lunch 12:30']);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hour by hour' })).toBeVisible();
  await page.getByRole('button', { name: 'Add something at 7:00 PM' }).focus();
  await page.keyboard.press('Enter'); // keyboard: on the hour
  const sheet = page.getByRole('dialog', { name: 'Add at 7:00 PM' });
  // "dinner" has its own usual window; the tapped hour still wins
  await sheet.getByLabel('What is it?').fill('Dinner with Ana 45 min');
  await expect(sheet.locator('.quick-preview')).toContainText('7 PM–7:45 PM');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('dialog', { name: 'Re-route from here' }).getByRole('button', { name: 'Use this plan' }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.hour-item', { hasText: 'Dinner with Ana' })).toContainText('7:00 PM–7:45 PM');
});

test('hour by hour: drag an item to move it', async ({ page }) => {
  await onboard(page, ['Lunch 12:30', 'Read 30 min after 2pm']);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const item = page.locator('.hour-item', { hasText: 'Read' });
  const before = await item.locator('.hour-item-body span').first().innerText();
  const grip = item.locator('.hour-grip');
  await grip.scrollIntoViewIfNeeded();
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let dy = 0; dy <= 144; dy += 12) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy); // two hours down
  await page.mouse.up();
  await expect(page.locator('.toast')).toContainText('pinned');
  const after = page.locator('.hour-item', { hasText: 'Read' });
  await expect(after).toContainText('Pinned');
  await expect(after.locator('.hour-item-body span').first()).not.toHaveText(before);
});

test('weather precautions: heavy rain while driving, then a hot sunny day', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T13:00:00+08:00'));
  await page.goto('/app?sky=heavy-rain');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('radio', { name: /Car or ride-hail/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('#quick-add').fill('Groceries before 8');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Plan my day' }).click();

  const card = page.locator('.precautions');
  await expect(card).toContainText('Drive safely');
  await expect(card).toContainText('headlights');
  await expect(card).toContainText('Avoid flooded streets');
  await expect(card).toContainText('Bring an umbrella');
  await card.getByRole('button', { name: 'Got it' }).click();
  await expect(card).toHaveCount(0);

  await page.goto('/app?sky=clear&feels=38&uv=10');
  const hot = page.locator('.precautions');
  await expect(hot).toContainText('Drink water, find shade');
  await expect(hot).toContainText('feel like 38°');
  await expect(hot).toContainText('Wear sunscreen');
  await expect(page.locator('.weather-line')).toContainText('feels');
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.precaution-strip')).toContainText('Wear sunscreen');
});

test('sign up with Google on the landing page: greeted by name, calendar already in', async ({ page }) => {
  await fakeGoogle(page);
  await page.clock.setFixedTime(MORNING);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Try it without signing up' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Google' }).first().click();

  await expect(page).toHaveURL(/\/app(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Welcome, Ana' })).toBeVisible();
  await expect(page.getByText('Your Google Calendar is connected')).toBeVisible();
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.calendar-card')).toContainText('Connected');
  await page.getByRole('button', { name: 'Plan my day' }).click(); // enabled: the calendar counts
  await expect(page.locator('main')).toContainText('Team standup');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('ana@example.com');
  await page.getByRole('button', { name: 'Close' }).click();

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Continue as Ana' }).first()).toBeVisible();
});

test('every section tab is on screen on a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.clock.setFixedTime(MORNING);
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Try an example day' }).click();
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav).toBeVisible();
  for (const name of ['Today', 'Plan', 'Calendar', 'Routines']) {
    const box = (await nav.getByRole('button', { name }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(box.height).toBeGreaterThanOrEqual(24);
  }
});
