import { test, Page } from '@playwright/test';
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

const resultPath = process.env.N8N_RESULT_PATH
  ? path.resolve(process.env.N8N_RESULT_PATH)
  : path.resolve(process.cwd(), '.n8n-result.json');

type RunStatus = 'ok' | 'no_items' | 'error';

const runHistory: string[] = [];
const addedUrls: string[] = [];
let lastStep = 'startup';
let finalStatus: RunStatus | null = null;
let finalError: string | undefined;

const buildPayload = (
  status: RunStatus,
  opts: { errorMessage?: string; finished: boolean; testStatus?: string },
) => ({
  status,
  error: status === 'error',
  errorMessage: opts.errorMessage ?? null,
  failedStep: status === 'error' ? lastStep : null,
  finished: opts.finished,
  testStatus: opts.testStatus ?? null,
  username,
  history: runHistory,
  addedUrls,
  addedCount: addedUrls.length,
  timestamp: new Date().toISOString(),
});

// Atomic write so n8n never reads a half-written file.
const writeResult = (payload: object) => {
  try {
    const tmpPath = `${resultPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, resultPath);
  } catch (writeError) {
    console.error(`Failed to write result file: ${writeError}`);
  }
};

// Every log updates the result file, so even a hard crash / kill leaves a
// valid JSON with error=true and the step it died on.
const startTime = Date.now();

const log = (message: string) => {
  const stamped = `[${((Date.now() - startTime) / 1000).toFixed(1)}s] ${message}`;
  runHistory.push(stamped);
  console.log(stamped);
  lastStep = message;
  writeResult(
    buildPayload('error', {
      errorMessage: `Run did not finish (last step: ${lastStep})`,
      finished: false,
    }),
  );
};

const emitResult = (status: RunStatus, error?: string) => {
  finalStatus = status;
  finalError = error;
  writeResult(buildPayload(status, { errorMessage: error, finished: true }));
};

if (!username || !password) {
  emitResult('error', 'Missing REVCOMPS_USERNAME or REVCOMPS_PASSWORD in .env.');
  throw new Error('Missing REVCOMPS_USERNAME or REVCOMPS_PASSWORD in .env.');
}

// Runs even when the test times out or fails mid-flight; stamps the file
// with Playwright's own verdict.
test.afterEach(async ({}, testInfo) => {
  const testStatus = testInfo.status ?? 'unknown';
  if (finalStatus && testStatus === 'passed') {
    writeResult(
      buildPayload(finalStatus, {
        errorMessage: finalError,
        finished: true,
        testStatus,
      }),
    );
    return;
  }
  const message =
    finalError ??
    testInfo.error?.message?.split('\n')[0] ??
    `Test ended with status "${testStatus}" (last step: ${lastStep})`;
  writeResult(
    buildPayload('error', {
      errorMessage: message,
      finished: false,
      testStatus,
    }),
  );
});

// The new site is a slow SPA; the free-ticket auto-add happens on login,
// so every run logs in fresh instead of reusing a stored session.
test('test', async ({ page }) => {
  const sleepRandom = async (minMs: number, maxMs: number) => {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await page.waitForTimeout(delay);
  };

  const acceptCookiesIfShown = async () => {
    const acceptCookies = page.getByRole('button', { name: /accept all/i }).first();
    if (await acceptCookies.isVisible().catch(() => false)) {
      await acceptCookies.click();
      log('Accepted cookies');
      await sleepRandom(250, 700);
    }
  };

  const pageText = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

  // The site throws full-screen modals (e.g. after the free ticket lands in
  // the cart) that swallow clicks. Close them before clicking anything vital.
  const dismissOverlays = async () => {
    for (let round = 1; round <= 3; round += 1) {
      const overlay = page.locator('div.fixed.inset-0:visible').last();
      if (!(await overlay.isVisible().catch(() => false))) {
        return;
      }
      const overlayText = (await overlay.innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      log(`Overlay detected (round ${round}): "${overlayText}"`);
      const closeButton = overlay
        .locator(
          'button[aria-label*="close" i], [data-test*="close" i], button:has-text("×"), button:has-text("Close"), button:has-text("No thanks"), button:has-text("Continue"), button:has-text("Got it"), button:has-text("OK")',
        )
        .first();
      if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.dispatchEvent('click');
        log('Clicked overlay close button');
      } else {
        await page.keyboard.press('Escape');
        log('Pressed Escape to close overlay');
      }
      await sleepRandom(600, 1200);
    }
    log('Overlay may still be present after 3 dismiss attempts.');
  };

  // Click that survives overlays: try a real click briefly, then fall back
  // to a synthetic event which ignores pointer interception.
  const clickThroughOverlays = async (locator: ReturnType<Page['locator']>, label: string) => {
    await dismissOverlays();
    try {
      await locator.click({ timeout: 10_000 });
      log(`Clicked ${label}`);
    } catch {
      await dismissOverlays();
      await locator.dispatchEvent('click');
      log(`Clicked ${label} (dispatchEvent fallback)`);
    }
  };

  try {
    test.setTimeout(240_000);
    log(`Starting test run as ${username}`);

    await page.goto('https://www.revcomps.com/login', { waitUntil: 'commit' });
    const emailInput = page
      .locator('[data-test="login-modal-input-name"], input[name="email"]')
      .first();
    const passwordInput = page
      .locator('[data-test="login-modal-input-password"], input[name="password"]')
      .first();
    await emailInput.waitFor({ timeout: 60_000 });
    log('Loaded login page');
    // Let the SPA hydrate; filling too early gets wiped by React re-renders.
    await page.waitForTimeout(3000);
    await acceptCookiesIfShown();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await emailInput.fill(username);
      await sleepRandom(250, 700);
      await passwordInput.fill(password);
      await sleepRandom(250, 700);
      if (
        (await emailInput.inputValue()) === username &&
        (await passwordInput.inputValue()) === password
      ) {
        break;
      }
      log(`Login fields were reset by the page; refilling (attempt ${attempt}).`);
      await page.waitForTimeout(1500);
    }
    log('Entered credentials');
    await acceptCookiesIfShown();
    await page.locator('#login-modal-conectare').click();
    log('Submitted login');
    const logoutButton = page.getByRole('button', { name: 'Logout' }).first();
    const authError = page
      .getByText(/authentication failed|check your credentials|account.*blocked/i)
      .first();
    await logoutButton.or(authError).first().waitFor({ timeout: 60_000 });
    if (!(await logoutButton.isVisible().catch(() => false))) {
      const authErrorText =
        (await authError.textContent().catch(() => null))?.trim() ??
        'no error message captured';
      throw new Error(`Login failed: ${authErrorText}`);
    }
    log('Logged in (free tickets are auto-added to cart on login)');
    await sleepRandom(500, 1200);

    // Collect free competitions from the listings.
    await page.goto('https://www.revcomps.com/current-competitions', { waitUntil: 'commit' });
    await page.getByRole('tab').first().waitFor({ timeout: 60_000 });
    log('Listings loaded');
    const allTab = page.getByRole('tab', { name: /all competitions/i });
    if (await allTab.isVisible().catch(() => false)) {
      await allTab.dispatchEvent('click');
      log('Selected All Competitions tab');
      await sleepRandom(1500, 2500);
    } else {
      const tabNames = await page.getByRole('tab').allTextContents();
      log(`All Competitions tab not found; tabs: ${tabNames.join(' | ')}`);
    }

    // Free comps render a "Free competition" view button; paid comps have an
    // Add button instead. Cards can be duplicated by the carousel, so visit
    // one button per unique card title.
    const freeButtons = page.getByRole('button', { name: /view competition/i });
    const freeButtonCount = await freeButtons.count();
    log(`Found ${freeButtonCount} free competition buttons`);

    const seenTitles = new Set<string>();
    const eligibleUrlList: string[] = [];
    for (let i = 0; i < freeButtonCount; i += 1) {
      // Re-query after each goBack since the SPA re-renders.
      const button = page.getByRole('button', { name: /view competition/i }).nth(i);
      if (!(await button.isVisible().catch(() => false))) {
        continue;
      }
      const title = (
        await button.evaluate(
          (el) => el.closest('div[class]')?.parentElement?.textContent ?? '',
        )
      ).trim();
      if (seenTitles.has(title)) {
        continue;
      }
      seenTitles.add(title);
      if (title.toLowerCase().includes('referral')) {
        log(`Filtered referral: ${title}`);
        continue;
      }

      await button.dispatchEvent('click');
      await page.waitForURL((url) => !url.pathname.includes('current-competitions'), {
        timeout: 30_000,
      });
      await sleepRandom(2000, 3500);
      const url = page.url();
      log(`Opened free competition: ${url}`);
      const text = await pageText(page);
      if (/YOU ARE ENTERED/i.test(text)) {
        log(`Already entered: ${url}`);
      } else if (/cannot purchase anymore tickets|max.*reached/i.test(text)) {
        log(`Skipping maxed-out competition: ${url}`);
      } else {
        // Login should have auto-added the ticket, but if the page offers an
        // explicit Add to cart button, use it as well.
        const addToCart = page.getByRole('button', { name: /add to cart/i }).first();
        if (await addToCart.isVisible().catch(() => false)) {
          await addToCart.click();
          log(`Clicked Add to cart: ${url}`);
          await sleepRandom(1000, 2000);
        }
        eligibleUrlList.push(url);
        log(`Eligible (not yet entered): ${url}`);
      }
      await page.goBack({ waitUntil: 'commit' });
      await page.getByRole('tab').first().waitFor({ timeout: 60_000 });
      await sleepRandom(800, 1500);
    }
    log(`Eligible competitions: ${eligibleUrlList.length}`);

    // The cart is the source of truth: free tickets land there on login.
    await page.goto('https://www.revcomps.com/cart', { waitUntil: 'commit' });
    log('Opened cart');
    // Resolve as soon as the cart shows either state.
    const checkoutButton = page.getByRole('button', { name: /proceed to checkout/i });
    await checkoutButton
      .or(page.getByText(/cart is currently empty/i))
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {
        log('Cart rendered neither checkout button nor empty message within 30s.');
      });
    await sleepRandom(1500, 3000);
    const cartText = await pageText(page);
    const totalMatch = cartText.match(/TOTAL:\s*£\s*([\d.]+)/i);
    const cartTotal = totalMatch ? Number(totalMatch[1]) : null;
    log(`Cart total: ${totalMatch ? `£${totalMatch[1]}` : 'not found'}`);

    const hasCheckout = await page
      .getByRole('button', { name: /proceed to checkout/i })
      .first()
      .isVisible()
      .catch(() => false);

    if (!hasCheckout || cartTotal === null) {
      if (eligibleUrlList.length === 0) {
        log('Cart empty and no eligible free competitions; nothing to do.');
        emitResult('no_items');
        return;
      }
      throw new Error(
        `Eligible free competitions found but cart has no checkout (${eligibleUrlList.join(', ')})`,
      );
    }

    const freeItemInCart = /£\s*0\.00/.test(cartText);
    if (eligibleUrlList.length === 0 && !freeItemInCart) {
      if (cartTotal > 0) {
        log(`Note: cart holds £${cartTotal.toFixed(2)} of paid items (left untouched).`);
      }
      log('No eligible free competitions and no free items in cart.');
      emitResult('no_items');
      return;
    }

    if (cartTotal > 0) {
      // Refuse to check out anything that costs money: the cart can contain
      // paid tickets the user added manually.
      throw new Error(
        `Cart total is £${cartTotal.toFixed(2)} (contains paid items); refusing to checkout. Clear the cart to let free entries through.`,
      );
    }

    addedUrls.push(...eligibleUrlList);
    await clickThroughOverlays(
      page.getByRole('button', { name: /proceed to checkout/i }).first(),
      'Proceed to checkout',
    );
    await sleepRandom(2500, 6000);

    if (isTestMode) {
      log('Test mode enabled; skipping order placement.');
      emitResult('ok');
      return;
    }

    const payNow = page
      .getByRole('button', { name: /pay now|place order|complete order/i })
      .first();
    await payNow.waitFor({ timeout: 60_000 });
    const payLabel = (await payNow.textContent())?.trim() ?? '';
    const payAmount = payLabel.match(/£\s*([\d.]+)/);
    if (payAmount && Number(payAmount[1]) > 0) {
      throw new Error(
        `Checkout button shows a non-zero amount ("${payLabel}"); refusing to pay.`,
      );
    }
    await clickThroughOverlays(payNow, `pay button ("${payLabel}")`);
    await sleepRandom(3000, 6000);
    // The recorded flow needed a second click on PAY NOW.
    if (await payNow.isVisible().catch(() => false)) {
      await clickThroughOverlays(payNow, 'pay button (second click)');
    }
    await sleepRandom(5000, 10000);
    log('Order placed');

    emitResult('ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stepAtFailure = lastStep;
    log(`Error: ${message}`);
    lastStep = stepAtFailure;
    emitResult('error', message);
    throw error;
  }
});
