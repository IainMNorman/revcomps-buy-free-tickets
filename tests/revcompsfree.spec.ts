import { test, expect } from '@playwright/test';
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

if (!username || !password) {
  throw new Error('Missing REVCOMPS_USERNAME or REVCOMPS_PASSWORD in .env.');
}

test.use({ storageState: { cookies: [], origins: [] } });

test('test', async ({ page }) => {
  const sleepRandom = async (minMs: number, maxMs: number) => {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await page.waitForTimeout(delay);
  };

  console.log('Starting test run');
  await page.goto('https://www.revcomps.com/');
  console.log('Loaded homepage');
  await sleepRandom(300, 900);
  await page.getByRole('button', { name: 'Accept All' }).click();
  console.log('Accepted cookies');
  await sleepRandom(250, 700);
  await page.getByRole('link', { name: 'Log In' }).click();
  console.log('Opened login');
  await sleepRandom(250, 700);
  await page.getByRole('textbox', { name: 'Username or Email Address' }).fill(username);
  console.log('Entered username');
  await sleepRandom(250, 700);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  console.log('Entered password');
  await sleepRandom(250, 700);
  await page.getByRole('button', { name: 'Log In' }).click();
  console.log('Submitted login');
  await page.waitForSelector('div.qode-pli');
  console.log('Listings loaded');

  const freeItems = page.locator(
    'div.qode-pli:has(div.price_image:has-text("free"))',
  );
  const freeItemCount = await freeItems.count();
  console.log(`Found ${freeItemCount} free items before filtering`);
  const items = await Promise.all(
    Array.from({ length: freeItemCount }, (_, i) => i).map(async (i) => {
      const item = freeItems.nth(i);
      const title = (await item.locator('.qode-pli-title').innerText()).trim();
      const url = (await item.locator('a.qode-pli-link').getAttribute('href')) ?? '';
      return { title, url };
    }),
  );
  console.log(`Collected ${items.length} item entries`);
  const uniqueUrlList = [
    ...new Set(
      items
        .filter(({ title, url }) => {
          const isReferral =
            title.toLowerCase().includes('referral') ||
            url.toLowerCase().includes('referral');
          if (isReferral) {
            console.log(`Filtered referral: ${title} - ${url}`);
          }
          return url && !isReferral;
        })
        .map(({ url }) => url),
    ),
  ];
  console.log(`Found ${uniqueUrlList.length} free items`);

  const eligibleUrlList: string[] = [];

  for (let i = 0; i < uniqueUrlList.length; i += 1) {
    const url = uniqueUrlList[i];
    console.log(`Free item ${i + 1}: ${url}`);
    await page.goto(url);
    console.log(`Opened item page: ${url}`);
    await sleepRandom(400, 1200);
    const hasTicketBanner = await page
      .getByText('YOU HAVE 1 TICKET ON THIS PRIZE', { exact: false })
      .isVisible();
    const maxTicketMessage = await page
      .getByText('You cannot purchase anymore tickets', { exact: false })
      .isVisible();
    if (hasTicketBanner || maxTicketMessage) {
      console.log(`Skipping already-held ticket: ${url}`);
      continue;
    }

    eligibleUrlList.push(url);
    console.log(`Eligible item: ${url}`);
    await page.locator('#question_select').selectOption('london');
    console.log('Selected answer: london');
    await sleepRandom(300, 900);
    await page.locator('#submitorder').click();
    console.log(`Added to cart: ${url}`);
    await sleepRandom(500, 1500);
  }

  if (eligibleUrlList.length === 0) {
    console.log('No eligible free items, skipping checkout.');
    return;
  }

  await page.goto('https://www.revcomps.com/cart/');
  console.log('Opened cart');
  await sleepRandom(500, 1200);
  await page.getByRole('link', { name: 'Proceed to checkout' }).click();
  console.log('Proceeded to checkout');
  await sleepRandom(700, 1400);
  await page.locator('#place_order').click();
  console.log('Placed order');
});
