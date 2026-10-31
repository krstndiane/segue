import { expect, test, type Page } from '@playwright/test';

/** A section in the bottom navigation. */
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name, exact: true });

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

test('the landing page explains Segue, shows the rain example on the real planner, and opens the demo or the app', async ({ page }) => {
  // "before 8" means 8 PM in the morning and 8 AM before dawn, so fix the clock.
  await page.clock.setFixedTime(MORNING);
  await page.goto('/');
  // Above the fold: what it is (a daily planner), what it does, and the two ways in.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your day, planned around real life.');
  await expect(page.locator('.lp-kicker')).toHaveText('Intelligent daily planner');
  await expect(page.locator('.lp-sub')).toContainText('tasks, routines and Google Calendar');
  for (const name of ['Get started', 'See how it works']) {
    const box = (await page.getByRole('link', { name }).first().boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 800));
  }
  // The five tabs, by the names the app uses.
  for (const name of ['Today', 'Plan', 'Calendar', 'Routines', 'Together']) await expect(page.locator('.lp-tour h3', { hasText: new RegExp(`^${name}$`) })).toBeVisible();
  // The hero shows the real Today screen on the sample day, and says it's a sample.
  await expect(page.locator('.lp-preview')).toContainText('Outdoor workout');
  await expect(page.locator('.lp-preview figcaption')).toHaveText('Segue’s Today screen, on a sample day');
  // Step 1 is the real plain-words reader.
  await page.locator('#lp-try').fill('Groceries before 8');
  await expect(page.locator('.lp-try-result')).toContainText('Before 8 PM');
  // The example: nothing until it rains; then real options that keep Class at 3:30.
  const example = page.locator('.lp-scenario');
  await expect(example).toContainText('Press “Make it rain”');
  await example.getByRole('button', { name: 'Make it rain' }).click();
  await expect(example).toContainText('Keeps Class at 3:30 PM exactly where it is');
  await expect(example.locator('.lp-sc-list.after')).toContainText('3:30 PM Class');
  await expect(example.locator('.lp-sc-list.after')).toContainText('Unchanged');
  await expect(example).toContainText('Sample scenario');
  const picks = example.getByRole('radio');
  expect(await picks.count()).toBeGreaterThanOrEqual(2);
  await picks.nth(1).click();
  await expect(picks.nth(1)).toHaveAttribute('aria-checked', 'true');
  await expect(example.locator('.lp-sc-list.after li').first()).toContainText(/Leaves \d+ min before Class/);
  // Into the demo, and back; then into the app without an account.
  await page.getByRole('link', { name: 'See how it works' }).first().click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole('heading', { name: 'This is a planned day in Segue' })).toBeVisible();
  await page.goto('/');
  await page.getByRole('link', { name: 'Get started' }).first().click();
  await expect(page).toHaveURL(/\/app(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Plan your day around real life' })).toBeVisible();
});

test('plan my day: leave a routine out for today only', async ({ page }) => {
  await onboard(page, ['Lunch 12:30', 'Stretch 20 min every day']);
  await tab(page, 'Plan').click();
  await expect(page).toHaveURL(/\/app\/plan(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Plan your day' })).toBeVisible();
  await page.getByText("What's in today").click();
  await page.getByText('Include Stretch today').locator('..').locator('.track').click();
  await page.getByRole('button', { name: 'Re-plan my day' }).click();
  await page.getByRole('dialog', { name: 'Re-route from here' }).getByRole('button', { name: 'Use this plan' }).click();
  await expect(page).toHaveURL(/\/app(\?|$)/);
  await expect(page.locator('main')).not.toContainText('Stretch');
  await tab(page, 'Routines').click();
  await expect(page.locator('main')).toContainText('Stretch'); // still a routine, back tomorrow
});

test('connect Google Calendar, leave one event out, and plan around the rest', async ({ page }) => {
  await fakeGoogle(page);
  await onboard(page, ['Lunch 12:30']);
  await tab(page, 'Plan').click();
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
  await tab(page, 'Plan').click();
  await expect(page.getByRole('heading', { name: 'Hour by hour' })).toBeVisible();
  await page.getByRole('button', { name: 'Add something at 7:00 PM' }).focus();
  await page.keyboard.press('Enter'); // keyboard: on the hour
  const sheet = page.getByRole('dialog', { name: 'Add at 7:00 PM' });
  // "dinner" has its own usual window; the tapped hour still wins
  await sheet.getByLabel('What is it?').fill('Dinner with Ana 45 min');
  await expect(sheet.locator('.quick-preview')).toContainText('7 PM–7:45 PM');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('dialog', { name: 'Re-route from here' }).getByRole('button', { name: 'Use this plan' }).click();
  await tab(page, 'Plan').click();
  await expect(page.locator('.hour-item', { hasText: 'Dinner with Ana' })).toContainText('7:00 PM–7:45 PM');
});

test('hour by hour: drag an item to move it', async ({ page }) => {
  await onboard(page, ['Lunch 12:30', 'Read 30 min after 2pm']);
  await tab(page, 'Plan').click();
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
  await tab(page, 'Plan').click();
  await expect(page.locator('.precaution-strip')).toContainText('Wear sunscreen');
});

test('sign up with Google on the landing page: greeted by name, calendar already in', async ({ page }) => {
  await fakeGoogle(page);
  await page.clock.setFixedTime(MORNING);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Get started' }).first()).toBeVisible();
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

test('the bottom navigation: five places, real addresses, back and refresh work, and nothing hides behind it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.clock.setFixedTime(MORNING);
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  // A new user lands on an open day, not on sample tasks.
  await expect(page.locator('main')).toContainText('Your day is open.');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav).toBeVisible();
  for (const name of ['Today', 'Plan', 'Calendar', 'Routines']) {
    const box = (await nav.getByRole('link', { name }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(box.y + box.height).toBeLessThanOrEqual(740);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await expect(nav.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  await tab(page, 'Routines').click();
  await expect(page).toHaveURL(/\/app\/routines\?sky=clear$/);
  await expect(nav.getByRole('link', { name: 'Routines' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Build a routine around something you want to do regularly.')).toBeVisible();
  // The last thing on the page scrolls clear of the bar.
  const add = page.getByRole('button', { name: 'Add a routine' });
  await add.scrollIntoViewIfNeeded();
  const navTop = (await nav.boundingBox())!.y;
  expect((await add.boundingBox())!.y + (await add.boundingBox())!.height).toBeLessThanOrEqual(navTop);
  await tab(page, 'Calendar').click();
  await expect(page).toHaveURL(/\/app\/days/);
  await page.goBack();
  await expect(nav.getByRole('link', { name: 'Routines' })).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Routines' })).toHaveAttribute('aria-current', 'page');
  // Keyboard: the tabs are links in order.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Plan' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app\/plan/);
});

test('a new day: yesterday’s calendar isn’t shown as today’s, one tap brings today’s events, and changes wait for review', async ({ page }) => {
  await fakeGoogle(page);
  // Google answers with the day that was asked for; `lunch` is added in Google Calendar later on.
  let lunch = false;
  await page.route('https://www.googleapis.com/calendar/v3/calendars/**', (r) => {
    const day = new URL(r.request().url()).searchParams.get('timeMin')!;
    const date = new Date(Date.parse(day) + 8 * 3_600_000).toISOString().slice(0, 10); // the Manila date asked for
    const items = r.request().url().includes('team%40x')
      ? []
      : [
          { id: `standup-${date}`, summary: 'Team standup', start: { dateTime: `${date}T10:00:00+08:00` }, end: { dateTime: `${date}T10:30:00+08:00` } },
          { id: `call-${date}`, summary: 'Client call', start: { dateTime: `${date}T15:00:00+08:00` }, end: { dateTime: `${date}T16:00:00+08:00` } },
          { id: `holiday-${date}`, summary: 'Company day off', start: { date }, end: { date: `${date.slice(0, 8)}${String(Number(date.slice(8)) + 1).padStart(2, '0')}` } },
          ...(lunch ? [{ id: `lunch-${date}`, summary: 'Lunch with Ana', start: { dateTime: `${date}T12:00:00+08:00` }, end: { dateTime: `${date}T13:00:00+08:00` } }] : []),
        ];
    return r.fulfill({ headers: cors, body: JSON.stringify({ items }) });
  });

  // Day one: sign up with Google and plan.
  await page.clock.setFixedTime(MORNING);
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).first().click();
  await expect(page.getByRole('heading', { name: 'Welcome, Ana' })).toBeVisible();
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Plan my day' }).click();
  await expect(page.locator('main')).toContainText('Client call');

  // The next morning: a fresh page, so Google's sign-in (kept in memory only) is gone.
  await page.clock.setFixedTime(new Date('2026-10-21T08:00:00+08:00'));
  await page.reload();
  const notice = page.locator('.nudge-calendar');
  await expect(notice).toContainText("Today's Google Calendar isn't loaded yet");
  await expect(page.locator('main')).not.toContainText('Client call');
  await notice.getByRole('button', { name: 'Refresh calendar' }).click();
  // Today's events are in, the day is planned around them, and the all-day event is shown without blocking time.
  await expect(page.locator('main')).toContainText('Client call');
  await expect(page.locator('main')).toContainText('Team standup');
  await expect(page.locator('.calendar-line')).toContainText('All day: Company day off');
  await expect(page.locator('.calendar-line')).toContainText('Google Calendar synced 8:00 AM');
  // Calendar events have no ✓ or skip: their status belongs to Google Calendar.
  await expect(page.getByRole('button', { name: 'Mark Client call as done' })).toHaveCount(0);

  // Later, lunch is added in Google Calendar; Segue picks it up on its own when you come back to the app.
  lunch = true;
  await page.clock.setFixedTime(new Date('2026-10-21T08:20:00+08:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.nudge-calendar')).toContainText('New: 12:00 PM–1:00 PM Lunch with Ana');
  await expect(page.locator('.timeline')).not.toContainText('Lunch with Ana'); // not until you say so
  await page.locator('.nudge-calendar').getByRole('button', { name: 'Update my plan' }).click();
  const sheet = page.getByRole('dialog', { name: 'Re-route from here' });
  await expect(sheet.locator('.preview')).toContainText('Lunch with Ana');
  await sheet.getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('.timeline')).toContainText('Lunch with Ana');
  await expect(page.locator('.nudge-calendar')).toHaveCount(0);
});
