// The map view of the search page. Place searches here use the platform's own
// areas, so no request goes to the third-party geocoder during tests.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  // A blocked map image or script shows up as a Content Security Policy error.
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) throw new Error(msg.text());
  });
});

test('the map shows the search by area, and choosing an area narrows the search', async ({ page }) => {
  await page.goto('/search.html?q=midwife&view=map');
  await expect(page.locator('#view-map')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#map-view')).toBeVisible();
  await expect(page.locator('#list-view')).toBeHidden();
  await expect(page.locator('#map .leaflet-interactive').first()).toBeVisible();
  await expect(page.locator('#map-status')).toContainText(/service/);
  const first = page.locator('#map-areas [data-area]').first();
  const area = (await first.innerText()).trim();
  await first.click();
  await expect(page.locator('#active-filters')).toContainText(area);
  await expect(page).toHaveURL(/view=map/);
});

test('a place search moves the map there and offers the services nearby', async ({ page }) => {
  await page.goto('/search.html?view=map');
  await page.fill('#place-q', 'Kilimani');
  await page.click('#place-form button[type=submit]');
  const popup = page.locator('.leaflet-popup');
  await expect(popup).toContainText('Kilimani');
  await popup.getByRole('button', { name: 'Show services near here' }).click();
  await expect(page.locator('#active-filters')).toContainText('Kilimani');
  await expect(page.locator('#map-status')).toContainText(/service/);
});

test('switching back to the list shows the results again', async ({ page }) => {
  await page.goto('/search.html?q=doula&view=map');
  await expect(page.locator('#map .leaflet-interactive').first()).toBeVisible();
  await page.click('#view-list');
  await expect(page.locator('#list-view')).toBeVisible();
  await expect(page.locator('#results .result').first()).toBeVisible();
  await expect(page).not.toHaveURL(/view=map/);
});
