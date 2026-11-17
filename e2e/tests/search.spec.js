// What a parent sees when searching: by meaning, in English and Kiswahili,
// with a place in the query, and when nothing in scope matches. Assertions
// are category-level, so they hold for the seed data and survive re-ranking.
const { test, expect } = require('@playwright/test');

// "Category · Area" line of each card (the card body's own .muted div).
const META = '.result .body > div.muted';
const categories = (page) => page.locator(`#results ${META}`).allInnerTexts();

test.beforeEach(async ({ page }) => {
  // Any script error on a page fails the test.
  page.on('pageerror', (err) => { throw err; });
});

test('the home page loads with search and the safety notice', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#search-form #q')).toBeVisible();
  await expect(page.locator('footer')).toContainText('999');
});

test('a question with no listing words still finds the right service', async ({ page }) => {
  await page.goto('/search.html?q=someone%20to%20help%20me%20breastfeed');
  await expect(page.locator('#result-count')).toHaveText(/[1-9]\d* services? found/);
  const first = (await categories(page))[0];
  expect(first).toMatch(/Lactation|Breastfeeding/);
});

test('Kiswahili with a place: the place becomes a filter, results are nannies there', async ({ page }) => {
  await page.goto('/search.html?q=natafuta%20yaya%20Karen');
  await expect(page.locator('.toast')).toContainText('Karen');
  await expect(page.locator('#active-filters')).toContainText('Karen');
  await expect(page.locator('#result-count')).toHaveText(/[1-9]\d* services? found/);
  for (const text of await categories(page)) {
    expect(text).toContain('Nanny');
    expect(text).toContain('Karen');
  }
});

test('nothing in the area: nearby areas are offered instead of an empty page', async ({ page }) => {
  await page.goto('/search.html?q=a%20midwife%20near%20Kilimani');
  await expect(page.locator('.suggest-heading')).toContainText('None in Kilimani');
  const offered = await page.locator(`#suggestions ${META}`).allInnerTexts();
  expect(offered.length).toBeGreaterThan(0);
  for (const text of offered) expect(text).toContain('Midwif');
});

test('an out-of-scope request is not answered with unrelated services', async ({ page }) => {
  await page.goto('/search.html?q=car%20mechanic');
  await expect(page.locator('#results .empty')).toContainText('No services match');
});

test('a weak match is shown as the closest services, and the page says so', async ({ page }) => {
  // "car mechanic" in Kiswahili: in no category, yet not far enough from
  // everything for the engine to reject it.
  await page.goto('/search.html?q=fundi%20wa%20magari');
  await expect(page.locator('#results .notice')).toContainText('None of these clearly matches');
});

test('a clear match carries no such notice', async ({ page }) => {
  await page.goto('/search.html?q=midwife');
  await expect(page.locator('#result-count')).toHaveText(/[1-9]\d* services? found/);
  await expect(page.locator('#results .notice')).toHaveCount(0);
});

test('a result opens its provider page', async ({ page }) => {
  await page.goto('/search.html?q=doula');
  const link = page.locator('#results .result h3 a').first();
  const name = (await link.innerText()).trim();
  await link.click();
  await expect(page).toHaveURL(/provider\.html\?id=\d+/);
  await expect(page.locator('#provider-root')).toContainText(name);
});

test('the API describes itself and tags every response with a request id', async ({ request }) => {
  const spec = await request.get('/api/openapi.yaml');
  expect(spec.ok()).toBeTruthy();
  expect(await spec.text()).toMatch(/^openapi: 3\.0\.\d/m);
  const res = await request.get('/api/services?q=doula', { headers: { 'X-Request-Id': 'e2e-trace-1' } });
  expect(res.headers()['x-request-id']).toBe('e2e-trace-1');
  expect((await res.json()).search_mode).toBe('semantic');
});
