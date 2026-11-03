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

test('the landing page: a route-aware planner, one main action, and the story told once on the real planner', async ({ page }) => {
  await page.clock.setFixedTime(MORNING);
  await page.goto('/');
  // Above the fold: what it is, what it does, and one obvious way in.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your day has a route. Segue helps you find your way.');
  await expect(page.locator('.lp-kicker')).toHaveText('Your route-aware daily planner');
  await expect(page.locator('.lp-sub')).toContainText('Plan your stops, routines, and commitments in one place.');
  const hero = page.locator('.lp-hero');
  for (const name of ['Try Segue', 'How it works']) {
    const box = (await hero.locator('.lp-copy').getByRole('link', { name }).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 800);
  }
  // No Google sign-in competing with it, anywhere on the page.
  await expect(page.getByRole('button', { name: /google/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /google/i })).toHaveCount(0);
  // The hero shows the real Today screen and the day's route, and says it's a sample.
  await expect(page.locator('.lp-ribbon')).toContainText('Ayala Triangle Gardens');
  await expect(page.locator('.lp-ribbon')).toContainText('3:30 PM · fixed');
  await expect(page.locator('.lp-preview')).toContainText('Outdoor workout');
  await expect(page.locator('.lp-preview figcaption')).toHaveText('Segue’s Today screen, on a sample day');
  // The five tabs, by the names the app uses.
  for (const name of ['Today', 'Plan', 'Calendar', 'Routines', 'Together']) await expect(page.locator('.lp-tour h3', { hasText: new RegExp(`^${name}$`) })).toBeVisible();

  // "How it works" goes to the one explanation on this page, not somewhere else.
  await hero.locator('.lp-copy').getByRole('link', { name: 'How it works' }).click();
  await expect(page).toHaveURL(/#how$/);
  const story = page.locator('#how');
  // The rain story exists once: one "Make it rain" on the whole page.
  await expect(page.getByRole('button', { name: 'Make it rain' })).toHaveCount(1);
  await expect(story.locator('.lp-steps [aria-current="step"]')).toContainText('The plan');
  await expect(story.locator('.lp-stage')).toContainText('Outdoor workout');
  await story.getByRole('button', { name: 'Make it rain' }).click();
  await expect(story.locator('.lp-steps [aria-current="step"]')).toContainText('Something changes');
  await expect(story.locator('.lp-sc-list li.hit')).toContainText('Outdoor workout');
  await story.getByRole('button', { name: 'See options' }).click();
  const picks = story.getByRole('radio');
  expect(await picks.count()).toBeGreaterThanOrEqual(2);
  await picks.nth(1).click();
  await expect(picks.nth(1)).toHaveAttribute('aria-checked', 'true');
  await expect(story.locator('.lp-sc-list li.changed')).toContainText(/Leaves \d+ min before Class/);
  await expect(story.locator('.lp-sc-list')).toContainText('Unchanged');
  await story.getByRole('button', { name: 'Use this' }).click();
  await expect(story.locator('.lp-stage h3')).toHaveText('You decide');
  await expect(story).toContainText('Class stays at 3:30 PM');
  await expect(story).toContainText('sample weather and real places from an OpenStreetMap snapshot');
  // Start over goes back to the plan.
  await story.getByRole('button', { name: 'Start over' }).click();
  await expect(story.locator('.lp-steps [aria-current="step"]')).toContainText('The plan');

  // The full-screen demo is its own, separately named link; Try Segue opens the app.
  await story.getByRole('link', { name: 'Open the full-screen demo' }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole('heading', { name: 'This is a planned day in Segue' })).toBeVisible();
  await page.goto('/');
  await page.getByRole('link', { name: 'Try Segue' }).first().click();
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
  await expect(page.getByRole('dialog', { name: 'Settings' }).locator('.gc-connected')).toContainText('Connected');
  await page.getByRole('button', { name: 'Close' }).click();
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

test('connect Google Calendar while getting started: one Connect button, then Connected with when it last synced', async ({ page }) => {
  await fakeGoogle(page);
  await page.clock.setFixedTime(MORNING);
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const card = page.locator('.calendar-card');
  // Exactly one way to connect, and no Google sign-in for Segue itself.
  await expect(card.getByRole('button')).toHaveCount(1);
  await card.getByRole('button', { name: 'Connect Google Calendar' }).click();
  await expect(card).toContainText('Connected');
  await expect(card).toContainText('Last synced today at');
  // Without a Segue account it is honest that this lasts for this visit only.
  await expect(card).toContainText('This visit only');
  await expect(card.getByRole('button', { name: 'Connect Google Calendar' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Plan my day' }).click(); // enabled: the calendar counts
  await expect(page.locator('main')).toContainText('Team standup');

  // Settings is the one place it's managed (status, sync, disconnect); no second sign-in there.
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.locator('.gc-connected')).toContainText('Last synced today at');
  await expect(settings.getByRole('button', { name: /Sign (up|in) with Google|Continue with Google/ })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Manage connection' }).click();
  await settings.getByRole('button', { name: 'Disconnect Google Calendar' }).click();
  await expect(settings.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible();
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

  // Day one: connect Google Calendar while getting started, and plan.
  await page.clock.setFixedTime(MORNING);
  await page.goto('/app');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('.calendar-card').getByRole('button', { name: 'Connect Google Calendar' }).click();
  await expect(page.locator('.calendar-card')).toContainText('Connected');
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

/** Where the motorcycle is, read from its transform, and whether that point lies on the road surface. */
async function bikeOnRoad(page: Page) {
  return page.evaluate(() => {
    const bike = document.querySelector<SVGGElement>('.lp-bike')!;
    const road = document.querySelector<SVGPathElement>('.lp-road-surface')!;
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(bike.getAttribute('transform') ?? '');
    const x = Number(m?.[1]);
    const y = Number(m?.[2]);
    return { x, y, at: Number(bike.dataset.at), facing: bike.dataset.facing, onRoad: road.isPointInStroke(new DOMPoint(x, y)) };
  });
}
/** The centre of step i's circle, in the road's coordinates. */
async function dotX(page: Page, i: number) {
  const dot = (await page.locator('#how .lp-step-dot').nth(i).boundingBox())!;
  const wrap = (await page.locator('#how .lp-steps-wrap').boundingBox())!;
  return { x: dot.x - wrap.x + dot.width / 2, r: dot.width / 2 };
}
/** Choose step i and sample the ride until it stops. */
async function ride(page: Page, i: number) {
  await page.locator('#how .lp-steps button').nth(i).click();
  const samples = [];
  for (let k = 0; k < 60; k++) {
    samples.push(await bikeOnRoad(page));
    if (k > 3 && samples.at(-1)!.at === samples.at(-2)!.at && samples.at(-2)!.at === samples.at(-3)!.at) break;
    await page.waitForTimeout(70);
  }
  return samples;
}
const STEP_TITLES = ['Here’s today’s route', 'It starts raining', 'Segue finds a practical way forward', 'You decide'];

test('how it works: the motorcycle never moves on its own', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await page.locator('.lp-bike').waitFor({ state: 'attached' });
  const start = await bikeOnRoad(page);
  expect(start.onRoad).toBe(true);
  // Not on load, not when the section scrolls into view, not after a while, not when scrolling around.
  await page.locator('#how .lp-steps-wrap').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  expect((await bikeOnRoad(page)).at).toBe(start.at);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1500);
  expect((await bikeOnRoad(page)).at).toBe(start.at);
  await expect(page.locator('#how .lp-steps > li.on')).toContainText('The plan');
  // The panel's text is readable on its card inside the navy section (not white on white).
  const contrast = await page.evaluate(() => {
    const lum = (c: string) => {
      const [r, g, b] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const fg = lum(getComputedStyle(document.querySelector('#how .lp-stage h3')!).color);
    const bg = lum(getComputedStyle(document.querySelector('#how .lp-stage')!).backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(contrast).toBeGreaterThan(7);
  // It rests just before Step 1, never on the number.
  const d1 = await dotX(page, 0);
  expect(d1.x - start.x).toBeGreaterThan(d1.r);
});

test('how it works: choosing a step rides the motorcycle along the road to it, forwards or back, and the panel follows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await page.locator('#how .lp-steps-wrap').scrollIntoViewIfNeeded();
  const steps = page.locator('#how .lp-steps > li');
  const stage = page.locator('#how .lp-stage h3');

  for (const [to, forward] of [[1, true], [2, true], [3, true], [0, false]] as const) {
    const samples = await ride(page, to);
    // Every sample on the road surface, always in one direction, and it really moved.
    for (const s of samples) expect(s.onRoad, `off the road at ${s.x},${s.y}`).toBe(true);
    for (let k = 1; k < samples.length; k++) {
      if (forward) expect(samples[k]!.at).toBeGreaterThanOrEqual(samples[k - 1]!.at);
      else expect(samples[k]!.at).toBeLessThanOrEqual(samples[k - 1]!.at);
    }
    expect(new Set(samples.map((s) => s.at)).size).toBeGreaterThan(4);
    const end = samples.at(-1)!;
    expect(end.facing).toBe(forward ? 'forward' : 'back');
    // Stopped beside the chosen circle, on the side it came from, clear of the number.
    const d = await dotX(page, to);
    const gap = forward ? d.x - end.x : end.x - d.x;
    expect(gap).toBeGreaterThan(d.r);
    expect(gap).toBeLessThan(70);
    await expect(steps.nth(to)).toHaveClass(/\bon\b/);
    await expect(stage).toHaveText(STEP_TITLES[to]!);
  }
  // Active, visited and not visited look different: after the tour, the others are all visited.
  for (const i of [1, 2, 3]) await expect(steps.nth(i)).toHaveClass(/visited/);
  await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step');

  // Choosing the step it's already at doesn't move it.
  const still = await bikeOnRoad(page);
  await page.locator('#how .lp-steps button').nth(0).click();
  await page.waitForTimeout(700);
  expect((await bikeOnRoad(page)).at).toBe(still.at);

  // Random order, each one lands where it should with the matching panel.
  for (const to of [2, 0, 3, 1]) {
    const end = (await ride(page, to)).at(-1)!;
    const d = await dotX(page, to);
    expect(Math.abs(end.x - d.x)).toBeGreaterThan(d.r);
    expect(Math.abs(end.x - d.x)).toBeLessThan(70);
    await expect(stage).toHaveText(STEP_TITLES[to]!);
  }
});

test('how it works: a new choice mid-ride redirects the motorcycle from where it is, without jumping', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await page.locator('#how .lp-steps-wrap').scrollIntoViewIfNeeded();
  const buttons = page.locator('#how .lp-steps button');
  await buttons.nth(3).click();
  await page.waitForTimeout(450);
  const mid = await bikeOnRoad(page);
  await buttons.nth(1).click(); // change of mind, while riding
  const trace = [mid];
  for (let k = 0; k < 40; k++) {
    await page.waitForTimeout(50);
    trace.push(await bikeOnRoad(page));
  }
  // Continuous: never more than a small step between samples, always on the road.
  for (let k = 1; k < trace.length; k++) {
    expect(Math.abs(trace[k]!.at - trace[k - 1]!.at)).toBeLessThan(90);
    expect(trace[k]!.onRoad).toBe(true);
  }
  const end = trace.at(-1)!;
  const d = await dotX(page, 1);
  expect(Math.abs(end.x - d.x)).toBeGreaterThan(d.r);
  expect(Math.abs(end.x - d.x)).toBeLessThan(70);
  await expect(page.locator('#how .lp-stage h3')).toHaveText(STEP_TITLES[1]!);
  // Rapid clicks: it ends at the last one chosen.
  for (const i of [3, 0, 2, 3, 2]) await buttons.nth(i).click();
  await page.waitForTimeout(2600);
  const last = await bikeOnRoad(page);
  const d2 = await dotX(page, 2);
  expect(Math.abs(last.x - d2.x)).toBeLessThan(70);
  await expect(page.locator('#how .lp-steps > li').nth(2)).toHaveClass(/\bon\b/);
});

test('how it works on a phone: the same road, the steps are easy to tap, and the motorcycle stays on it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#how .lp-steps-wrap').scrollIntoViewIfNeeded();
  for (let i = 0; i < 4; i++) {
    const box = (await page.locator('#how .lp-steps button').nth(i).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  for (const to of [2, 3, 0]) {
    const samples = await ride(page, to);
    for (const s of samples) expect(s.onRoad).toBe(true);
    await expect(page.locator('#how .lp-stage h3')).toHaveText(STEP_TITLES[to]!);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // Resizing rebuilds the road and keeps the motorcycle at its step.
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.waitForTimeout(400);
  const now = await bikeOnRoad(page);
  expect(now.onRoad).toBe(true);
  const d = await dotX(page, 0);
  expect(Math.abs(now.x - d.x)).toBeLessThan(70);
});

test('how it works with reduced motion: choosing a step moves the motorcycle there at once, with no ride', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('#how .lp-steps-wrap').scrollIntoViewIfNeeded();
  const a = await bikeOnRoad(page);
  await page.waitForTimeout(1500);
  expect((await bikeOnRoad(page)).at).toBe(a.at);
  await page.locator('#how .lp-steps button').nth(2).click();
  await page.waitForTimeout(60);
  const b = await bikeOnRoad(page);
  expect(b.onRoad).toBe(true);
  const d = await dotX(page, 2);
  expect(Math.abs(b.x - d.x)).toBeLessThan(70);
  await page.waitForTimeout(400);
  expect((await bikeOnRoad(page)).at).toBe(b.at); // nothing left moving
  await expect(page.locator('#how .lp-stage h3')).toHaveText(STEP_TITLES[2]!);
});

/**
 * A university timetable in Google Calendar, answered for whatever window is
 * asked: Programming 1 (Mon/Wed/Fri 8–10, a recurring series), Mathematics
 * (Mon/Wed/Fri 1–2:30 PM, a series), Gym (Mon/Wed/Fri 5–6:30 PM, typed in each
 * week) and a weekly "Ana" (Sunday evening: unclear what it is).
 */
async function timetable(page: Page) {
  await fakeGoogle(page);
  await page.route('https://www.googleapis.com/calendar/v3/calendars/**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.includes('team%40x') || decodeURIComponent(url.pathname).includes('team@x')) return r.fulfill({ headers: cors, body: JSON.stringify({ items: [] }) });
    const from = Date.parse(url.searchParams.get('timeMin')!);
    const to = Date.parse(url.searchParams.get('timeMax')!);
    const items: ({ id: string } & Record<string, unknown>)[] = [];
    for (let t = from - 86_400_000; t < to + 86_400_000; t += 86_400_000) {
      const date = new Date(t + 8 * 3_600_000).toISOString().slice(0, 10); // Manila date
      const wd = new Date(`${date}T12:00:00+08:00`).getUTCDay();
      const at = (hm: string) => `${date}T${hm}:00+08:00`;
      const add = (id: string, summary: string, s: string, e: string, extra: object = {}) => {
        if (Date.parse(at(s)) < to && Date.parse(at(e)) > from) items.push({ id: `${id}-${date}`, summary, start: { dateTime: at(s) }, end: { dateTime: at(e) }, ...extra });
      };
      if ([1, 3, 5].includes(wd)) {
        add('prog', 'Programming 1', '08:00', '10:00', { recurringEventId: 'prog', location: 'PUP Main Building, Room 301' });
        add('math', 'Mathematics', '13:00', '14:30', { recurringEventId: 'math' });
        add('gym', 'Gym', '17:00', '18:30');
      }
      if (wd === 0) add('ana', 'Ana', '20:00', '20:30');
    }
    return r.fulfill({ headers: cors, body: JSON.stringify({ items: [...new Map(items.map((i) => [i.id, i])).values()] }) });
  });
}

test('routine learning: Segue reads the calendar, suggests the weekly routine, the person confirms and corrects it, and the plan uses it', async ({ page }) => {
  await timetable(page);
  // A Wednesday morning, before class.
  await page.clock.setFixedTime(new Date('2026-11-04T07:00:00+08:00'));
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('.calendar-card').getByRole('button', { name: 'Connect Google Calendar' }).click();
  await expect(page.locator('.calendar-card')).toContainText('Connected');
  await page.getByRole('button', { name: 'Plan my day' }).click();

  // Today says there's something to look at; nothing has been changed yet.
  const nudge = page.locator('.routine-nudge');
  await expect(nudge).toContainText('We’ve started learning your weekly routine');
  await expect(nudge).toContainText('Nothing changes until you confirm');
  await nudge.click();
  await expect(page).toHaveURL(/\/app\/routines/);

  const review = page.locator('.rl');
  await expect(review.getByRole('heading', { name: 'We’ve started learning your weekly routine.' })).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/rl-review.png`, fullPage: true });
  const card = (name: string) => review.locator('.rl-card', { has: page.getByRole('heading', { name, exact: true }) });
  await expect(card('Programming 1')).toContainText('Class');
  await expect(card('Programming 1')).toContainText('Fixed');
  await expect(card('Programming 1')).toContainText('Mon, Wed, Fri · 8:00 AM–10:00 AM');
  await expect(card('Mathematics')).toContainText('1:00 PM–2:30 PM');
  await expect(card('Gym')).toContainText('Fitness');
  await expect(card('Gym')).toContainText('Flexible');
  // Unsure: it asks instead of stating.
  await expect(card('Ana')).toContainText('Not sure about this one');
  // Nothing is a routine yet.
  await expect(page.locator('.blocks')).toHaveCount(0);

  // "Ana" isn't a routine; Mathematics gets a correction before saving; the rest Segue is sure about.
  await card('Ana').getByRole('button', { name: 'Not a routine' }).click();
  await expect(card('Ana')).toHaveCount(0);
  await card('Mathematics').getByRole('button', { name: 'Change' }).click();
  await card('Mathematics').getByLabel('Name').fill('Math 21');
  await card('Mathematics').getByRole('button', { name: 'Save routine' }).click();
  await review.getByRole('button', { name: /Save the 2 Segue is sure about/ }).click();
  await expect(page.locator('.rl')).toHaveCount(0);

  // They're routines now, with where they came from and whether they can move.
  const routines = page.getByRole('region', { name: 'Routines' });
  for (const name of ['Programming 1', 'Math 21', 'Gym']) await expect(routines).toContainText(name);
  await expect(routines.locator('li', { hasText: 'Gym' })).toContainText('Flexible');
  await expect(routines.locator('li', { hasText: 'Programming 1' })).toContainText('From your Google Calendar');
  const week = page.getByRole('region', { name: 'Your week' });
  await expect(week.locator('li', { hasText: 'Wed' })).toContainText('8:00 AM Programming 1');
  await expect(week.locator('li', { hasText: 'Tue' })).toContainText('Open');

  // A later sync doesn't suggest them again, or duplicate them.
  await page.reload();
  await expect(page.locator('.rl')).toHaveCount(0);
  await expect(routines.locator('li', { hasText: 'Programming 1' })).toHaveCount(1);

  // The plan: classes at their exact times (once each), the gym flexible around 5 PM (once), and a 2-hour assignment around them.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Today' }).click();
  await page.locator('#quick-add').fill('Programming assignment 2h');
  await page.keyboard.press('Enter');
  // Adding to today proposes a new plan; accept it (it opens a moment later).
  const sheet = page.getByRole('dialog', { name: 'Re-route from here' });
  await sheet.getByRole('button', { name: 'Use this plan' }).click({ timeout: 10_000 });
  await expect(sheet).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Today' }).click();

  const plan = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('segue');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const names = [...db.objectStoreNames];
    const tx = db.transaction(names[0]!, 'readonly');
    const day = await new Promise<{ plan?: { items: { title: string; start: string; end: string; fixed?: boolean }[] } }>((res) => {
      const g = tx.objectStore(names[0]!).get('day');
      g.onsuccess = () => res(g.result);
    });
    return day?.plan?.items ?? [];
  });
  const items = plan.map((i) => ({ ...i, s: Date.parse(i.start), e: Date.parse(i.end) }));
  const at = (title: string) => items.filter((i) => i.title === title);
  expect(at('Programming 1')).toHaveLength(1);
  expect(new Date(at('Programming 1')[0]!.start).toISOString()).toBe(new Date('2026-11-04T08:00:00+08:00').toISOString());
  expect(at('Mathematics')).toHaveLength(1); // today's calendar event (the routine steps aside)
  expect(at('Math 21')).toHaveLength(0);
  const gym = at('Gym');
  expect(gym).toHaveLength(1);
  expect(gym[0]!.fixed).toBeFalsy();
  expect(gym[0]!.s).toBeGreaterThanOrEqual(Date.parse('2026-11-04T16:00:00+08:00'));
  expect(gym[0]!.e).toBeLessThanOrEqual(Date.parse('2026-11-04T20:00:00+08:00'));
  const task = at('Programming assignment');
  expect(task).toHaveLength(1);
  for (const c of [...at('Programming 1'), ...at('Mathematics')]) expect(task[0]!.e <= c.s || task[0]!.s >= c.e).toBe(true);
  // Today says why the gym is there, and doesn't call the gym event a calendar change (the routine stands in for it).
  await expect(page.locator('.tag-routine').first()).toBeVisible();
  await expect(page.locator('.nudge-calendar')).toHaveCount(0);
  if (process.env.SHOTS) {
    await page.screenshot({ path: `${process.env.SHOTS}/rl-today.png`, fullPage: true });
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Routines' }).click();
    await page.screenshot({ path: `${process.env.SHOTS}/rl-routines.png`, fullPage: true });
  }
});
