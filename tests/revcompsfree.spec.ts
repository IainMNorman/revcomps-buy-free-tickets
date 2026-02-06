import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const loadEnvFile = () => {
  const envFilePath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envFilePath)) {
    return;
  }

  const contents = fs.readFileSync(envFilePath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
};

loadEnvFile();

const username = process.env.REVCOMPS_USERNAME;
const password = process.env.REVCOMPS_PASSWORD;
const isTestMode =
  process.env.REVCOMPS_TEST_MODE?.toLowerCase() === 'true' ||
  process.env.REVCOMPS_TEST_MODE === '1';

if (!username || !password) {
  throw new Error('Missing REVCOMPS_USERNAME or REVCOMPS_PASSWORD in .env.');
}

const runHistory: string[] = [];
const addedUrls: string[] = [];
const resultPath = process.env.N8N_RESULT_PATH
  ? path.resolve(process.env.N8N_RESULT_PATH)
  : path.resolve(process.cwd(), '.n8n-result.json');
const storageStatePath = process.env.REVCOMPS_STORAGE_STATE_PATH
  ? path.resolve(process.env.REVCOMPS_STORAGE_STATE_PATH)
  : path.resolve(process.cwd(), '.revcomps-storage-state.json');

const log = (message: string) => {
  runHistory.push(message);
  console.log(message);
};

const emitResult = (status: 'ok' | 'no_items' | 'error', error?: string) => {
  const payload = {
    status,
    history: runHistory,
    addedUrls,
    addedCount: addedUrls.length,
    error,
  };
  fs.writeFileSync(resultPath, JSON.stringify(payload), 'utf8');
};

test.use({
  storageState: fs.existsSync(storageStatePath)
    ? storageStatePath
    : { cookies: [], origins: [] },
});

test('test', async ({ page }) => {
  const sleepRandom = async (minMs: number, maxMs: number) => {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await page.waitForTimeout(delay);
  };

  try {
    test.setTimeout(120_000);
    log('Starting test run');
    await page.goto('https://www.revcomps.com/');
    log('Loaded homepage');
    await page.addStyleTag({
      content: `
        .iframe-container,
        .iframe-container-hp,
        .video-responsive {
          pointer-events: none !important;
        }
        .iframe-container iframe,
        .iframe-container-hp iframe,
        .video-responsive iframe {
          pointer-events: none !important;
        }
      `,
    });
    log('Disabled video pointer events');
    await sleepRandom(300, 900);
    const acceptCookies = page.getByRole('button', { name: 'Accept All' });
    if (await acceptCookies.isVisible()) {
      await acceptCookies.click();
      log('Accepted cookies');
      await sleepRandom(250, 700);
    } else {
      log('There was no cookie banner.');
    }

    const loginLink = page.getByRole('link', { name: 'Log In' });
    if (await loginLink.isVisible()) {
      await loginLink.click();
      log('Opened login');
      await sleepRandom(250, 700);
      await page.getByRole('textbox', { name: 'Username or Email Address' }).fill(username);
      log('Entered username');
      await sleepRandom(250, 700);
      await page.getByRole('textbox', { name: 'Password' }).fill(password);
      log('Entered password');
      await sleepRandom(250, 700);
      await page.getByRole('button', { name: 'Log In' }).click();
      log('Submitted login');
    } else {
      log('Already logged in; skipping login.');
    }
    await page.context().storageState({ path: storageStatePath });
    log(`Saved storage state: ${storageStatePath}`);
    
    await page.waitForSelector('a.rcfs-card');
    log('Listings loaded');
    await page.waitForSelector('.rcfs-topbar');
    const chips = page.locator('.rcfs-topbar .rcfs-chip');
    const chipCount = await chips.count();
    log(`Topbar chip count: ${chipCount}`);
    if (chipCount > 0) {
      const chipTexts = await chips.allTextContents();
      log(`Topbar chip labels: ${chipTexts.map((t) => t.trim()).join(' | ')}`);
      const activeChips = await page
        .locator('.rcfs-topbar .rcfs-chip.is-active')
        .allTextContents();
      if (activeChips.length > 0) {
        log(`Active chip(s) before click: ${activeChips.map((t) => t.trim()).join(' | ')}`);
      } else {
        log('No active chip before click.');
      }
    }
    const freeTab = page.locator('.rcfs-topbar .rcfs-chip[data-idx="12"]');
    if (await freeTab.isVisible()) {
      const isActive = await freeTab.evaluate((el) => el.classList.contains('is-active'));
      const freeTabText = (await freeTab.textContent())?.trim() ?? '';
      const freeTabClass = await freeTab.evaluate((el) => el.className);
      log(`FREE tab found: text="${freeTabText}" class="${freeTabClass}" active=${isActive}`);
      if (!isActive) {
        await freeTab.scrollIntoViewIfNeeded();
        let activated = false;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (attempt === 1) {
            await freeTab.click({ force: true });
            log('Selected FREE tab (click)');
          } else if (attempt === 2) {
            await freeTab.dispatchEvent('click');
            log('Selected FREE tab (dispatchEvent)');
          } else {
            await freeTab.evaluate((el) => el.click());
            log('Selected FREE tab (element.click)');
          }
          try {
            await page.waitForFunction(
              () =>
                !!document
                  .querySelector('.rcfs-topbar .rcfs-chip[data-idx="12"]')
                  ?.classList.contains('is-active'),
              { timeout: 1500 },
            );
            activated = true;
            break;
          } catch {
            log(`FREE tab still inactive after attempt ${attempt}.`);
          }
        }
        await sleepRandom(400, 900);
        const activeAfter = await page
          .locator('.rcfs-topbar .rcfs-chip.is-active')
          .allTextContents();
        if (activeAfter.length > 0) {
          log(`Active chip(s) after click: ${activeAfter.map((t) => t.trim()).join(' | ')}`);
        } else {
          log('No active chip after click.');
        }
        if (!activated) {
          log('FREE tab did not become active; filtering may not have applied.');
        }
      } else {
        log('FREE tab already active; skipping click.');
      }
    } else {
      log('FREE tab not found; continuing.');
      const chipsWithIdx = await page
        .locator('.rcfs-topbar .rcfs-chip')
        .evaluateAll((els) =>
          els.map((el) => ({
            text: (el.textContent || '').trim(),
            idx: el.getAttribute('data-idx'),
            className: el.className,
          })),
        );
      log(`Topbar chip details: ${JSON.stringify(chipsWithIdx)}`);
    }
    
    await page.waitForSelector('a.rcfs-card');
    const freeItems = page.locator(
      'a.rcfs-card:has(.rcfs-badge-price:has-text("free"))',
    );

    const freeItemCount = await freeItems.count();
    log(`Found ${freeItemCount} free items before filtering`);
    const items = await Promise.all(
      Array.from({ length: freeItemCount }, (_, i) => i).map(async (i) => {
        const item = freeItems.nth(i);
        const title = (await item.locator('.rcfs-name').innerText()).trim();
        const url = (await item.getAttribute('href')) ?? '';
        return { title, url };
      }),
    );
    log(`Collected ${items.length} item entries`);
    const uniqueUrlList = [
      ...new Set(
        items
          .filter(({ title, url }) => {
            const isReferral =
              title.toLowerCase().includes('referral') ||
              url.toLowerCase().includes('referral');
            if (isReferral) {
              log(`Filtered referral: ${title} - ${url}`);
            }
            return url && !isReferral;
          })
          .map(({ url }) => url),
      ),
    ];
    log(`Found ${uniqueUrlList.length} free items`);

    const eligibleUrlList: string[] = [];

    for (let i = 0; i < uniqueUrlList.length; i += 1) {
      const url = uniqueUrlList[i];
      log(`Free item ${i + 1}: ${url}`);
      await page.goto(url);
      log(`Opened item page: ${url}`);
      await sleepRandom(400, 1200);
      const hasTicketBanner = await page
        .getByText('YOU HAVE 1 TICKET ON THIS PRIZE', { exact: false })
        .isVisible();
      const maxTicketMessage = await page
        .getByText('You cannot purchase anymore tickets', { exact: false })
        .isVisible();
      if (hasTicketBanner || maxTicketMessage) {
        log(`Skipping already-held ticket: ${url}`);
        continue;
      }

      eligibleUrlList.push(url);
      log(`Eligible item: ${url}`);
      await page.locator('#submitorder').click();
      log(`Added to cart: ${url}`);
      addedUrls.push(url);
      await sleepRandom(500, 1500);
    }

    if (eligibleUrlList.length === 0) {
      log('No eligible free items, skipping checkout.');
      emitResult('no_items');
      return;
    }

    await page.goto('https://www.revcomps.com/cart/');
    log('Opened cart');
    await sleepRandom(2500, 10000);
    await page.getByRole('link', { name: 'Proceed to checkout' }).click();
    log('Proceeded to checkout');
    await sleepRandom(2500, 10000);
    if (isTestMode) {
      log('Test mode enabled; skipping order placement.');
      emitResult('ok');
      return;
    }

    await page.locator('#place_order').click();
    log('Placed order');
    await sleepRandom(5000, 10000);

    emitResult('ok');

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error: ${message}`);
    emitResult('error', message);
    throw error;
  }
});
