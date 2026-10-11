import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { createLanServer } from '../server/app.js';
import { selectMenu } from './select-menu.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-languages-'));
const server = createLanServer({
  port: 0,
  host: '127.0.0.1',
  dataDir: dir,
  joinCode: '654321',
  publicDir: path.resolve(process.env.LINCHUAN_PUBLIC_DIR || 'dist'),
});
await server.start();
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const evidence =
  process.env.LINCHUAN_QA_DIR ||
  path.join(os.tmpdir(), 'linchuan-language-evidence');
const photo = await sharp({
  create: { width: 720, height: 320, channels: 3, background: '#447b9d' },
})
  .png()
  .toBuffer();
try {
  await fs.mkdir(evidence, { recursive: true });
  for (const language of ['zh', 'en', 'ko', 'ja']) {
    const catalog = JSON.parse(
      await fs.readFile(`src/locales/${language}.json`, 'utf8'),
    ) as Record<string, string>;
    const t = (key: string) => catalog[key];
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        locale: `${language}-${language === 'zh' ? 'CN' : language === 'en' ? 'US' : language === 'ko' ? 'KR' : 'JP'}`,
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1536, height: 1024 },
        isMobile: mobile,
        hasTouch: mobile,
        ...(mobile
          ? {
              userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
            }
          : {}),
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.getPort()}`);
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        new RegExp(`^${language}-`),
      );
      await expect(
        page.getByRole('heading', { name: t('连接你的设备'), exact: true }),
      ).toBeVisible();
      await page.getByLabel(t('6 位连接码')).fill('000000');
      await page
        .getByRole('button', { name: t('进入聊天室'), exact: true })
        .click();
      await expect(page.getByRole('alert')).toHaveText(
        t('连接码不正确，请查看服务电脑的邻传页面。'),
      );
      await page
        .getByLabel(t('设备名称'), { exact: true })
        .fill(`${language}-${mobile ? 'phone' : 'desktop'}`);
      await page.getByLabel(t('6 位连接码')).fill('654321');
      await page
        .getByRole('button', { name: t('进入聊天室'), exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: t('公共聊天室'), exact: true }),
      ).toBeVisible();
      await selectMenu(page, t('外观主题'), t('深色'));
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page
        .getByRole('textbox', { name: t('输入消息'), exact: true })
        .fill('原文保留 · 한국어 · 日本語 · English');
      await page.getByRole('button', { name: t('发送'), exact: true }).click();
      await expect(
        page
          .getByText('原文保留 · 한국어 · 日本語 · English', { exact: true })
          .first(),
      ).toBeVisible();
      await page.locator('input[type=file][accept]').setInputFiles({
        name: 'photo.png',
        mimeType: 'image/png',
        buffer: photo,
      });
      const file = page
        .locator('.message-row')
        .filter({ hasText: 'photo.png' })
        .last();
      await expect(file.locator('img')).toBeVisible();
      await expect(
        file.getByRole('button', { name: t('删除文件'), exact: true }),
      ).toBeVisible();
      if (mobile) {
        await expect(
          file.getByRole('button', { name: t('保存'), exact: true }),
        ).toHaveCount(1);
        await expect(file.locator('.download-button')).toHaveCount(0);
      }
      await file.locator('.image-preview').click();
      await expect(
        page.getByRole('button', { name: t('关闭图片预览') }),
      ).toBeVisible();
      await page.getByRole('button', { name: t('关闭图片预览') }).click();
      await page.screenshot({
        path: path.join(
          evidence,
          `${language}-${mobile ? 'mobile' : 'desktop'}-dark.png`,
        ),
        fullPage: true,
      });
      await selectMenu(page, t('外观主题'), t('浅色'));
      await page.screenshot({
        path: path.join(
          evidence,
          `${language}-${mobile ? 'mobile' : 'desktop'}-light.png`,
        ),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${language} overflow`,
      );
      const switched = language === 'en' ? 'ja' : 'en';
      await page.getByRole('button', { name: t('语言'), exact: true }).click();
      await page
        .getByRole('menuitemradio', {
          name: switched === 'ja' ? '日本語' : 'English',
          exact: true,
        })
        .click();
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        new RegExp(`^${switched}-`),
      );
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        new RegExp(`^${switched}-`),
      );
      await expect(
        page
          .getByText('原文保留 · 한국어 · 日本語 · English', { exact: true })
          .first(),
      ).toBeVisible();
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Four languages passed: browser detection, localized errors, chat/media controls, original content, persisted selection, light/dark desktop/mobile, no page errors or horizontal overflow.',
  );
} finally {
  await browser.close();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
}
