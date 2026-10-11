import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { createLanServer } from '../server/app.js';
import { selectMenu } from './select-menu.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-visual-'));
const server = createLanServer({
  port: 0,
  host: '127.0.0.1',
  dataDir: dir,
  joinCode: '654321',
  publicDir: path.resolve(process.env.LINCHUAN_PUBLIC_DIR || 'dist'),
});
await server.start();
const browser = await chromium.launch({ headless: true });
const evidence =
  process.env.LINCHUAN_QA_DIR ||
  path.join(os.tmpdir(), 'linchuan-visual-evidence');
const base = `http://127.0.0.1:${server.getPort()}`;
const join = async (page: Page, name: string, phone = false) => {
  await page.goto(base);
  for (const label of ['设备名称', '6 位连接码']) {
    const field = page.getByLabel(label, { exact: true });
    await field.focus();
    const focus = await field.evaluate((node) => {
      const style = getComputedStyle(node);
      return { outline: style.outlineStyle, shadow: style.boxShadow };
    });
    assert.deepEqual(focus, { outline: 'none', shadow: 'none' });
  }
  await page.getByLabel('设备名称', { exact: true }).fill(name);
  if (phone)
    await page.getByRole('button', { name: '手机', exact: true }).click();
  await page.getByLabel('6 位连接码').fill('654321');
  await page.getByRole('button', { name: '进入聊天室', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '公共聊天室', exact: true }),
  ).toBeVisible();
};
const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
};
try {
  await fs.mkdir(evidence, { recursive: true });
  const a = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1536, height: 1024 },
  });
  const b = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  });
  const c = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  });
  const desktop = await a.newPage();
  const study = await b.newPage();
  let phone = await c.newPage();
  await join(desktop, '我的电脑');
  await join(study, '书房电脑');
  await join(phone, '我的手机', true);
  await send(phone, '照片已经整理好了。');
  await send(desktop, '直接传过来就好。');
  for (const page of [desktop, phone]) {
    const actions = page
      .locator('.text-bubble')
      .first()
      .locator('.message-actions');
    const copy = (await actions
      .getByRole('button', { name: '复制消息' })
      .boundingBox())!;
    const remove = (await actions
      .getByRole('button', { name: '删除消息' })
      .boundingBox())!;
    assert.ok(Math.abs(copy.y - remove.y) < 1);
    assert.ok(Math.abs(remove.x - copy.x - copy.width - 4) < 1);
  }
  await phone.locator('input[type=file][accept]').setInputFiles({
    name: '海边照片.jpg',
    mimeType: 'image/png',
    buffer: await fs.readFile('design/demo-coast.png'),
  });
  await expect(
    desktop.getByText('海边照片.jpg', { exact: true }),
  ).toBeVisible();
  await phone.locator('input[type=file]:not([accept])').setInputFiles({
    name: '旅行资料.zip',
    mimeType: 'application/zip',
    buffer: Buffer.alloc(18000),
  });
  await expect(
    desktop.getByText('旅行资料.zip', { exact: true }),
  ).toBeVisible();
  // Compare the same workspace identity at both breakpoints. This keeps the
  // concept's incoming/outgoing content consistent without adding a device.
  const responsive = await browser.newContext({
    storageState: await a.storageState(),
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  });
  phone = await responsive.newPage();
  await phone.goto(base);
  await expect(phone.getByText('旅行资料.zip', { exact: true })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await selectMenu(desktop, '外观主题', theme === 'dark' ? '深色' : '浅色');
    await selectMenu(phone, '外观主题', theme === 'dark' ? '深色' : '浅色');
    await desktop.screenshot({
      path: path.join(evidence, `workbench-${theme}-desktop.png`),
      fullPage: true,
    });
    await phone.screenshot({
      path: path.join(evidence, `workbench-${theme}-mobile.png`),
      fullPage: true,
    });
    await desktop.setViewportSize({ width: 1440, height: 732 });
    await desktop.screenshot({
      path: path.join(evidence, `compact-${theme}-1440.png`),
      fullPage: true,
    });
    assert.equal(
      await desktop
        .locator('.sidebar')
        .evaluate((node) => node.getBoundingClientRect().width),
      232,
    );
    assert.equal(
      await desktop
        .locator('.app-header')
        .evaluate((node) => node.getBoundingClientRect().height),
      56,
    );
    assert.equal(
      await desktop.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await desktop.setViewportSize({ width: 1536, height: 1024 });
  }
  const geometry = await desktop.locator('.composer').evaluate((composer) => {
    const input = composer.querySelector('textarea')!;
    const style = getComputedStyle(input);
    const inputLineCenter =
      input.getBoundingClientRect().top +
      parseFloat(style.paddingTop) +
      parseFloat(style.lineHeight) / 2;
    const send = composer
      .querySelector('.send-button')!
      .getBoundingClientRect();
    return {
      lineCenter: inputLineCenter,
      sendCenter: send.top + send.height / 2,
      inputHeight: input.clientHeight,
    };
  });
  assert.ok(
    Math.abs(geometry.lineCenter - geometry.sendCenter) <= 1,
    JSON.stringify(geometry),
  );
  await desktop
    .getByRole('textbox', { name: '输入消息', exact: true })
    .fill('第一行\n第二行\n第三行');
  assert.ok(
    (await desktop.locator('.composer textarea').boundingBox())!.height >
      geometry.inputHeight,
  );
  const menuStyle = async (page: Page) =>
    page.getByRole('menu').evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        border: style.borderColor,
        radius: style.borderRadius,
        padding: style.padding,
        font: style.fontFamily,
      };
    });
  await desktop.getByRole('button', { name: '语言', exact: true }).click();
  const sharedStyle = await menuStyle(desktop);
  await desktop.keyboard.press('Escape');
  const themeTrigger = desktop.getByRole('button', {
    name: '外观主题',
    exact: true,
  });
  await themeTrigger.focus();
  await desktop.keyboard.press('Enter');
  assert.deepEqual(await menuStyle(desktop), sharedStyle);
  await desktop.keyboard.press('End');
  await expect(
    desktop.getByRole('menuitemradio', { name: '深色', exact: true }),
  ).toBeFocused();
  await desktop.keyboard.press('Enter');
  await expect(themeTrigger).toHaveAttribute('data-value', 'dark');
  await expect(themeTrigger).toBeFocused();
  await themeTrigger.click();
  await desktop.screenshot({
    path: path.join(evidence, 'theme-menu.png'),
    fullPage: true,
  });
  await desktop.keyboard.press('Escape');
  const address = desktop.getByRole('button', {
    name: '局域网地址',
    exact: true,
  });
  if (await address.count()) {
    await address.click();
    assert.deepEqual(await menuStyle(desktop), sharedStyle);
    const lastOption = desktop.getByRole('menuitemradio').last();
    const lastUrl = (await lastOption.innerText()).trim();
    await desktop.screenshot({
      path: path.join(evidence, 'address-menu.png'),
      fullPage: true,
    });
    await lastOption.click();
    await expect(desktop.locator('.qr-frame img')).toHaveAttribute(
      'src',
      `/api/qr?url=${encodeURIComponent(lastUrl)}`,
    );
  }
  await desktop.getByRole('button', { name: '设备设置', exact: true }).click();
  await desktop.getByLabel('设备名称', { exact: true }).focus();
  await desktop.getByRole('button', { name: '设备类型', exact: true }).click();
  assert.deepEqual(await menuStyle(desktop), sharedStyle);
  await desktop.screenshot({
    path: path.join(evidence, 'device-menu.png'),
    fullPage: true,
  });
  await desktop.keyboard.press('Escape');
  await desktop
    .getByRole('button', { name: '关闭设备设置', exact: true })
    .click();
  for (const label of ['输入消息', '连接地址']) {
    const field = desktop.getByRole('textbox', { name: label, exact: true });
    await field.focus();
    const focus = await field.evaluate((node) => {
      const style = getComputedStyle(node);
      return { outline: style.outlineStyle, shadow: style.boxShadow };
    });
    assert.deepEqual(focus, { outline: 'none', shadow: 'none' });
  }
  assert.equal(await desktop.locator('select').count(), 0);
  for (const width of [360, 390, 430]) {
    await phone.setViewportSize({ width, height: 844 });
    await phone.getByRole('button', { name: '语言', exact: true }).click();
    for (const label of ['简体中文', 'English', '한국어', '日本語'])
      await expect(
        phone.getByRole('menuitemradio', { name: label, exact: true }),
      ).toBeVisible();
    assert.equal(
      await phone.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await phone.screenshot({
      path: path.join(evidence, `flags-${width}.png`),
      fullPage: true,
    });
    await phone.keyboard.press('Escape');
  }
  console.log(
    'Visual verification: compact 1440×732 and 1536×1024 desktop, light/dark 390×844, flag menu at 360/390/430, centered placeholder, growing multiline composer, compact media actions.',
  );
} finally {
  await browser.close();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
}
