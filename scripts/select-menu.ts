import { type Page } from '@playwright/test';

export async function selectMenu(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('menuitemradio', { name: option, exact: true }).click();
}
