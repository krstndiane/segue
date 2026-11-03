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
  // Earlier steps can be revisited, later ones can't be skipped to.
  await story.getByRole('button', { name: 'Start over' }).click();
  await expect(story.getByRole('button', { name: /You decide/ })).toBeDisabled();

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

  // Settings links to the one place it's managed; no second sign-in there.
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('button', { name: 'Manage Google Calendar' })).toBeVisible();
  await expect(settings.getByRole('button', { name: /Sign (up|in) with Google|Continue with Google/ })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Manage Google Calendar' }).click();
  await expect(page).toHaveURL(/\/app\/calendar/);
  await page.getByRole('button', { name: 'Manage connection' }).click();
  await page.getByRole('button', { name: 'Disconnect Google Calendar' }).click();
  await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible();
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
    return { x, y, at: Number(bike.dataset.at), onRoad: road.isPointInStroke(new DOMPoint(x, y)) };
  });
}

test('how it works: a motorcycle rides the winding road from Step 1 to Step 4, once, lighting each milestone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  // Before the section is in view it waits at the start, on the road.
  await page.locator('.lp-bike').waitFor({ state: 'attached' });
  const before = await bikeOnRoad(page);
  expect(before.onRoad).toBe(true);
  await page.waitForTimeout(600);
  expect((await bikeOnRoad(page)).at).toBe(before.at);

  // The order the milestones are reached in.
  await page.evaluate(() => {
    (window as unknown as { reached: number[] }).reached = [];
    document.querySelectorAll('#how .lp-steps > li').forEach((li, i) =>
      new MutationObserver(() => {
        const r = (window as unknown as { reached: number[] }).reached;
        if (li.classList.contains('passed') && !r.includes(i)) r.push(i);
      }).observe(li, { attributes: true, attributeFilter: ['class'] }),
    );
  });
  await page.locator('#how .lp-steps-wrap').scrollIntoViewIfNeeded();
  // Sampled through the ride: always on the road, only ever moving forward.
  const samples = [];
  for (let i = 0; i < 40; i++) {
    samples.push(await bikeOnRoad(page));
    await page.waitForTimeout(120);
  }
  for (const s of samples) expect(s.onRoad, `off the road at ${s.x},${s.y}`).toBe(true);
  for (let i = 1; i < samples.length; i++) expect(samples[i]!.at).toBeGreaterThanOrEqual(samples[i - 1]!.at);
  expect(new Set(samples.map((s) => s.at)).size).toBeGreaterThan(15); // it really moved
  await expect(page.getByRole('button', { name: 'Ride again' })).toBeVisible({ timeout: 4000 });
  expect(await page.evaluate(() => (window as unknown as { reached: number[] }).reached)).toEqual([0, 1, 2, 3]);
  await expect(page.locator('#how .lp-steps > li').nth(3)).toHaveClass(/arrived/);

  // It parks just short of Step 4: close to the circle, never on top of the number.
  const end = await bikeOnRoad(page);
  const dot4 = (await page.locator('#how .lp-step-dot').nth(3).boundingBox())!;
  const wrap = (await page.locator('#how .lp-steps-wrap').boundingBox())!;
  const dx = dot4.x - wrap.x + dot4.width / 2 - end.x;
  expect(dx).toBeGreaterThan(dot4.width / 2);
  expect(dx).toBeLessThan(80);
  // The four milestones stay readable.
  for (const name of ['The plan', 'Something changes', 'Segue finds alternatives', 'You decide']) await expect(page.locator('#how .lp-steps')).toContainText(name);

  // Scrolling away and back doesn't restart it.
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(400);
  await page.locator('#how .lp-steps-wrap').scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  expect((await bikeOnRoad(page)).at).toBe(end.at);

  // Ride again replays it from the start.
  await page.getByRole('button', { name: 'Ride again' }).click();
  await page.waitForTimeout(250);
  expect((await bikeOnRoad(page)).at).toBeLessThan(end.at);
  await expect(page.getByRole('button', { name: 'Ride again' })).toBeVisible({ timeout: 8000 });

  // On a phone the same road, the same ride: the road is rebuilt for the new width and the bike stays on it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  expect((await bikeOnRoad(page)).onRoad).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('how it works with reduced motion: a still road, the motorcycle waiting at the start, no ride', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('#how .lp-steps-wrap').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const a = await bikeOnRoad(page);
  expect(a.onRoad).toBe(true);
  await page.waitForTimeout(2500);
  expect((await bikeOnRoad(page)).at).toBe(a.at);
  await expect(page.locator('#how .lp-steps > li.passed')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ride again' })).toHaveCount(0);
  // Before Step 1, so the number stays clear.
  const dot1 = (await page.locator('#how .lp-step-dot').first().boundingBox())!;
  const wrap = (await page.locator('#how .lp-steps-wrap').boundingBox())!;
  expect(a.x).toBeLessThan(dot1.x - wrap.x);
});
