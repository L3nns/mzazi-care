// A new parent: create an account, choose preferences, see explained
// recommendations, save a service, then delete the account. Writes to the
// database (and removes what it wrote), so it runs only
// with E2E_WRITE=1.
const { test, expect } = require('@playwright/test');

test.skip(!process.env.E2E_WRITE, 'set E2E_WRITE=1 to run tests that create data');

test('register, set preferences, get explained recommendations, save one, delete the account', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  const email = `e2e-${Date.now()}@example.com`;

  await page.goto('/account.html?tab=register');
  await page.fill('#full_name', 'E2E Parent');
  await page.fill('#email', email);
  await page.fill('#password', 'e2e-password-1');
  await page.fill('#location', 'Westlands');
  await page.click('#auth-form button[type=submit]');

  // Registration lands on preferences.
  const prefs = page.locator('#pref-form');
  await expect(prefs).toBeVisible();
  await prefs.getByLabel(/Lactation/).first().check();
  await prefs.locator('button[type=submit]').click();
  await expect(page.locator('.toast')).toBeVisible();

  // Recommendations on the home page carry their reasons.
  await page.goto('/');
  const why = page.locator('#home-recs details.why').first();
  await expect(why).toBeVisible();
  await why.locator('summary').click();
  await expect(why.locator('li').first()).toBeVisible();

  // Save the first recommended service from its page.
  await page.locator('#home-recs a[href^="provider.html"]').first().click();
  const save = page.locator('#save-btn');
  await expect(save).toHaveAttribute('aria-pressed', 'false');
  await save.click();
  await expect(save).toHaveAttribute('aria-pressed', 'true');

  // Delete the account from "Your data" (this also cleans up after the test).
  await page.goto('/account.html?tab=data');
  await page.fill('#del-password', 'e2e-password-1');
  await page.click('#del-form button[type=submit]');
  await expect(page.locator('#del-error')).toContainText('confirm');     // the box is required
  await page.check('#del-confirm');
  await page.click('#del-form button[type=submit]');
  await expect(page.locator('#account-root')).toContainText('Your account has been deleted');

  // The account is gone: signing in again fails.
  await page.goto('/account.html?tab=login');
  await page.fill('#email', email);
  await page.fill('#password', 'e2e-password-1');
  await page.click('#auth-form button[type=submit]');
  await expect(page.locator('#auth-error')).toBeVisible();
});
