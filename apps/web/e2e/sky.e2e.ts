import { expect, test, type Page } from '@playwright/test';

/** Finish first-run setup quickly, with nothing added. */
async function setUp(page: Page, url: string, at: string) {
  await page.clock.setFixedTime(new Date(at));
  await page.goto(url);
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.locator('main')).toBeVisible();
}

/** The page background as [r, g, b]. */
const background = (page: Page) =>
  page.evaluate(() => {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
    return [m[0]!, m[1]!, m[2]!] as [number, number, number];
  });
const lightness = ([r, g, b]: number[]) => (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;

test.describe('the page takes on the sky', () => {
  test.use({ colorScheme: 'light' });

  test('dark under a night sky, even with a light system theme', async ({ page }) => {
    await setUp(page, '/app?sky=clear', '2026-10-20T21:00:00+08:00');
    await expect(page.locator('html')).toHaveAttribute('data-sky-theme', 'dark');
    await expect.poll(async () => lightness(await background(page))).toBeLessThan(0.15);
    // the status bar matches the top of the night sky
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#050918');
  });

  test('light and sky-tinted at noon', async ({ page }) => {
    await setUp(page, '/app?sky=clear', '2026-10-20T12:00:00+08:00');
    await expect(page.locator('html')).toHaveAttribute('data-sky-theme', 'light');
    await expect.poll(async () => lightness(await background(page))).toBeGreaterThan(0.8);
    const [r, , b] = await background(page);
    expect(b).toBeGreaterThan(r); // a little blue from the sky
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#1c5fb8');
  });

  test('the status bar starts neutral, before the app knows the sky', async ({ page }) => {
    await page.route('**/src/main.tsx', (r) => r.abort()); // the page before any script runs
    await page.goto('/app');
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#f2f4f8');
  });
});

const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const MAKATI = { latitude: 14.5547, longitude: 121.0244 };
const SYDNEY = { latitude: -33.8688, longitude: 151.2093 };

/** A fake API: rain south of the equator, clear north of it, and a name for each area. Records what was asked. */
async function fakeApi(page: Page) {
  const asked: string[] = [];
  await page.route('http://127.0.0.1:9/v1/weather/now**', (r) => {
    const url = new URL(r.request().url());
    asked.push(url.search);
    const south = Number(url.searchParams.get('lat')) < 0;
    const now = south
      ? { condition: 'rain', isDay: true, temperatureC: 19, observedAt: '2026-10-20T13:00:00+11:00', utcOffsetMinutes: 660, timezone: 'Australia/Sydney' }
      : { condition: 'clear', isDay: true, temperatureC: 31, observedAt: '2026-10-20T10:00:00+08:00', utcOffsetMinutes: 480, timezone: 'Asia/Manila' };
    return r.fulfill({ headers: cors, body: JSON.stringify({ now }) });
  });
  await page.route('http://127.0.0.1:9/v1/place-name**', (r) => {
    const south = Number(new URL(r.request().url()).searchParams.get('lat')) < 0;
    return r.fulfill({ headers: cors, body: JSON.stringify({ name: south ? 'Sydney' : 'Urdaneta, Makati' }) });
  });
  return asked;
}

/**
 * A user who turns location down. Headless Chromium leaves an unanswered
 * request pending forever, so the answer is played here: the permission reads
 * "prompt" and the request fails as denied, until `__blocked` is cleared.
 */
async function userSaysNo(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __blocked: boolean; __asked: number };
    w.__blocked = true;
    w.__asked = 0;
    const geo = navigator.geolocation;
    const realWatch = geo.watchPosition.bind(geo);
    const realGet = geo.getCurrentPosition.bind(geo);
    const realQuery = navigator.permissions.query.bind(navigator.permissions);
    const denied = { code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'User denied Geolocation' };
    geo.watchPosition = (ok, err, opts) => {
      w.__asked++;
      if (!w.__blocked) return realWatch(ok, err, opts);
      setTimeout(() => err?.(denied as GeolocationPositionError), 50);
      return -1;
    };
    geo.getCurrentPosition = (ok, err, opts) => {
      if (!w.__blocked) return realGet(ok, err, opts);
      setTimeout(() => err?.(denied as GeolocationPositionError), 50);
    };
    navigator.permissions.query = (d) =>
      w.__blocked && d.name === 'geolocation'
        ? Promise.resolve({ state: 'prompt', addEventListener() {}, removeEventListener() {} } as unknown as PermissionStatus)
        : realQuery(d);
  });
}

test.describe('where the sky is', () => {
  test('the location drives the sky, with no button to press', async ({ page, context }) => {
    await context.setGeolocation(MAKATI);
    const asked = await fakeApi(page);
    await setUp(page, '/app', '2026-10-20T10:00:00+08:00');
    await expect(page.locator('.where-name')).toHaveText('Urdaneta, Makati');
    await expect(page.locator('.condition')).toHaveText('Clear and sunny');
    // only a rough area (about 1 km) leaves the phone
    expect(asked[0]).toBe('?lat=14.55&lng=121.02');
    // the pin is a status, and nothing asks the user to pick a place or a sky
    await expect(page.locator('.where-button')).toHaveAttribute('role', 'status');
    await expect(page.getByRole('button', { name: /use my location|update my location/i })).toHaveCount(0);

    // moving far away brings that place's weather, name and clock
    await context.setGeolocation(SYDNEY);
    await expect(page.locator('.where-name')).toHaveText('Sydney');
    await expect(page.locator('.condition')).toHaveText('Rain');
    expect(asked).toContain('?lat=-33.87&lng=151.21');
  });

  test('asks on its own, then says plainly when location is blocked', async ({ page }) => {
    await userSaysNo(page);
    await page.clock.setFixedTime(new Date('2026-10-20T10:00:00+08:00'));
    await page.goto('/app?sky=clear');
    // first-run setup says why, and the browser asks without a tap
    await expect(page.locator('.ob-card')).toContainText('Segue uses where you are to match the sky and plan your day.');
    await expect(page.locator('.ob-card')).toContainText("Allow location to match your sky. Open your browser's site settings, then reload.");
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBeGreaterThan(0);
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.locator('.location-banner')).toHaveText("Allow location to match your sky. Open your browser's site settings, then reload.");
    // the device's time zone stands in, and says so
    await expect(page.locator('.where-name')).toHaveText('Manila');
    await expect(page.locator('.where-button .where-note')).toHaveText('Using your time zone');
    await expect(page.locator('.precautions')).toHaveCount(0); // not the user's own weather
  });

  test('picks up by itself once the user allows location', async ({ page }) => {
    await userSaysNo(page);
    await fakeApi(page);
    await setUp(page, '/app', '2026-10-20T10:00:00+08:00');
    await expect(page.locator('.location-banner')).toHaveText(/Allow location to match your sky/);
    // the user allows it in site settings and comes back to the tab
    await page.evaluate(() => {
      (window as unknown as { __blocked: boolean }).__blocked = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('.where-name')).toHaveText('Urdaneta, Makati');
    await expect(page.locator('.location-banner')).toHaveCount(0);
  });
});

test('the status bar goes back to neutral on the landing page', async ({ page }) => {
  await setUp(page, '/app?sky=clear', '2026-10-20T21:00:00+08:00');
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#050918');
  await page.evaluate(() => {
    history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.locator('.lp-hero')).toBeVisible();
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#f2f4f8');
});

test('previews any time and place from the address bar', async ({ page }) => {
  // noon on the device, but the preview asks for 9 PM
  await setUp(page, '/app?sky=clear&time=21:00', '2026-10-20T12:00:00+08:00');
  await expect(page.locator('html')).toHaveAttribute('data-sky-theme', 'dark');
  await expect(page.locator('.condition')).toHaveText('Clear night');
  // dusk in Manila is 5:45 PM
  await page.goto('/app?sky=clear&time=17:45');
  await expect(page.locator('.condition')).toHaveText('Clear sky');
  // and somewhere else: midday in Sydney is daytime there
  await page.goto('/app?sky=clear&time=12:00&lat=-33.87&lng=151.21');
  await expect(page.locator('.condition')).toHaveText('Clear and sunny');
});
