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

test('ask about your day: answers from the plan, and changes nothing without a yes', async ({ page }) => {
  await onboard(page, ['Read 1h', 'Dinner with Ana 6:30pm-7:30pm']);
  await page.getByRole('button', { name: 'Ask about your day' }).click();
  const panel = page.getByRole('dialog', { name: 'Ask about your day' });
  const ask = async (q: string) => {
    await panel.getByLabel('Ask about your day').fill(q);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  };
  await ask("What's my next commitment?");
  await expect(panel.locator('.assistant-msg.assistant').last()).toContainText('Dinner with Ana (set time)');
  await ask('Move dinner to 8pm');
  await expect(panel.locator('.assistant-msg.assistant').last()).toContainText("set-time commitment, so Segue doesn't move it");
  await ask('Move read to 4pm');
  await panel.getByRole('button', { name: 'Yes, move to 4 PM' }).click();
  await expect(panel.locator('.assistant-confirm')).toContainText('Move Read to 4 PM?');
  await panel.locator('.assistant-confirm').getByRole('button', { name: 'Yes' }).click();
  await expect(panel.locator('.assistant-msg.assistant').last()).toContainText('Done: Read moved to 4:00 PM and pinned');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('main')).toContainText(/4:00\s*PM\s*in 7 h\s*Read/);
});

test('ask: "my meeting is running late" asks when it ends, then shows a proposal that keeps the meeting', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T14:30:00+08:00'));
  await page.goto('/app?sky=clear');
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (const t of ['Team meeting 2pm-3pm', 'Read 2h']) {
    await page.locator('#quick-add').fill(t);
    await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Plan my day' }).click();
  await expect(page.locator('main')).toContainText('Team meeting');

  await page.getByRole('button', { name: 'Ask about your day' }).click();
  const panel = page.getByRole('dialog', { name: 'Ask about your day' });
  const ask = async (q: string) => {
    await panel.getByLabel('Ask about your day').fill(q);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  };
  await ask('My meeting is running late. Fix my schedule.');
  await expect(panel.locator('.assistant-msg.assistant').last()).toContainText('About when will Team meeting end?');
  await ask('3:30');
  await expect(panel.locator('.assistant-msg.assistant').last()).toContainText("Keep 2:30 PM–3:30 PM free for Team meeting and rebuild the rest? Read will move later or say why it can't.");
  await panel.getByRole('button', { name: 'Keep until 3:30 PM free' }).click();
  await expect(panel.locator('.assistant-msg.assistant').last()).toContainText('Nothing changes until you tap');
  const sheet = page.getByRole('dialog', { name: 'Re-route from here' });
  await expect(sheet.locator('.preview')).toContainText('Team meeting running over');
  await expect(sheet.locator('.preview')).toContainText('Team meeting');
  await expect(sheet).not.toContainText('Dropped');
  await sheet.getByRole('button', { name: 'Use this plan' }).click();
  await expect(page.locator('main')).toContainText('Team meeting');
  await expect(page.locator('.timeline')).toContainText(/3:30\s*PM[\s\S]*Read/);
});

test('other options for an item: checked offline, and keeping the plan changes nothing', async ({ page }) => {
  await onboard(page, ['Study at a café 1h after 2pm']);
  await page.getByRole('button', { name: 'Details' }).first().click();
  await page.getByRole('button', { name: /See other options/ }).click();
  const sheet = page.getByRole('dialog', { name: /Other options for/ });
  await expect(sheet).toContainText('Offline');
  await sheet.getByRole('button', { name: 'Keep my plan' }).click();
  await expect(sheet).toHaveCount(0);
});

test('one tap on ✓ marks done, by mouse or keyboard, survives a reload, and can be brought back', async ({ page }) => {
  await onboard(page, ['Read 1h', 'Call mom 20 min', 'Stretch 15 min']);
  const rows = page.locator('.timeline .swipe');
  const first = rows.first();
  const title = (await first.locator('.tl-title').innerText()).split('\n')[0]!.trim();
  const done = first.getByRole('button', { name: `Mark ${title} as done` });
  await expect(done).toBeVisible();
  // A double tap still counts once.
  await done.dblclick();
  await expect(page.locator('.toast')).toContainText('Nice, marked done.');
  await expect(page.locator('.timeline')).not.toContainText(title);
  await expect(page.locator('.finished summary')).toHaveText('1 done today');

  // Keyboard: tab to the next ✓ and press Enter.
  const second = page.locator('.timeline .swipe').first();
  const title2 = (await second.locator('.tl-title').innerText()).split('\n')[0]!.trim();
  await second.locator('.tl-card').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: `Mark ${title2} as done` })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.finished summary')).toHaveText('2 done today');

  await page.reload();
  await expect(page.locator('.finished summary')).toHaveText('2 done today');
  await page.locator('.finished summary').click();
  await page.locator('.finished li', { hasText: title }).getByRole('button', { name: 'Bring back' }).click();
  await expect(page.locator('main')).toContainText(title);
  await expect(page.locator('.finished summary')).toHaveText('1 done today');
});

test('skipping keeps the rest of the day where it was; moving up happens only after a preview and Apply', async ({ page }) => {
  await onboard(page, ['Study programming 1h after 9am', 'Review notes 1h after 9am', 'Work on a project 1h after 9am']);
  const times = async () => Object.fromEntries(await page.locator('.next, .timeline .swipe').evaluateAll((els) => els.map((e) => [e.querySelector('.next-title, .tl-title')!.childNodes[0]!.textContent!.trim(), (e.querySelector('.tl-time') ?? e.querySelector('.next-when'))!.textContent!.trim()])));
  const before = await times();
  const firstTitle = (await page.locator('.next-title').innerText()).trim();

  // Skip the first: nothing else moves.
  await page.locator('.next').getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.toast')).toContainText('Skipped. The rest of your day stays as it is.');
  const afterSkip = await times();
  for (const [t, at] of Object.entries(afterSkip)) if (t !== firstTitle && before[t] && !/in \d/.test(at)) expect(at).toBe(before[t]);

  // Ignoring the offer changes nothing, even after a reload.
  await page.reload();
  await expect(page.locator('.finished summary')).toHaveText('1 skipped today'.replace(/^/, '0 done, '));
  expect(await times()).toEqual(afterSkip);

  // Ask, look, keep: nothing changes.
  await page.locator('.finished summary').click();
  await page.locator('.finished li', { hasText: firstTitle }).getByRole('button', { name: 'Bring back' }).click();
  await page.locator('.next').getByRole('button', { name: 'Skip' }).click();
  await page.locator('.toast').getByRole('button', { name: 'Move tasks up' }).click();
  const sheet = page.getByRole('dialog', { name: 'Suggested schedule adjustment' });
  await expect(sheet.locator('.moveup-list li').first()).toContainText('→');
  const listed = await sheet.locator('.moveup-list li').allInnerTexts();
  await sheet.getByRole('button', { name: 'Keep current schedule' }).click();
  await expect(sheet).toHaveCount(0);
  expect(await times()).toEqual(afterSkip);

  // Ask again and apply: exactly what was shown happens.
  await page.locator('.finished summary').click();
  await page.locator('.finished li', { hasText: firstTitle }).getByRole('button', { name: 'Bring back' }).click();
  await page.locator('.next').getByRole('button', { name: 'Skip' }).click();
  await page.locator('.toast').getByRole('button', { name: 'Move tasks up' }).click();
  await expect(sheet.locator('.moveup-list li')).toHaveText(listed);
  await sheet.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.locator('.toast')).toContainText(/moved up/);
  // Exactly what the preview listed: each moved item now starts at its new time (or is happening now).
  const applied = await times();
  for (const line of listed) {
    const [title, change] = line.split(': ') as [string, string];
    const to = change.split('→')[1]!.trim();
    expect(applied[title.trim()]).toMatch(new RegExp(`^(${to.replace(/\s/g, '\\s*')}|Now)`));
  }
  await page.reload();
  await expect(page.locator('.next')).toBeVisible();
  expect(await times()).toEqual(applied);
});
