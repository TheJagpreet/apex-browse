import { expect, test } from '@playwright/test';
import { startBenchmarkServer } from '../benchmark/app.js';

test('renamed-control oracle distinguishes implicit submission from clicking the requested control', async ({ page }) => {
  const app = await startBenchmarkServer();
  try {
    await page.goto(`${app.baseUrl}/renamed-control`);
    await page.getByRole('textbox', { name: 'Message' }).fill('Hello');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect.poll(() => app.outcome('renamed-control')?.payload).toEqual({ message: 'Hello', activation: 'implicit-submit' });

    app.reset('renamed-control');
    await page.reload();
    await page.getByRole('textbox', { name: 'Message' }).fill('Hello');
    await page.getByRole('button', { name: 'Sent' }).click();
    await expect.poll(() => app.outcome('renamed-control')?.payload).toEqual({ message: 'Hello', activation: 'button-click' });
  } finally { await app.close(); }
});
