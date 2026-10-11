import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { chromium, expect, type Page } from '@playwright/test';
import { createLanServer } from '../server/app.js';
import { selectMenu } from './select-menu.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-browser-'));
const server = createLanServer({
  port: 0,
  host: '127.0.0.1',
  dataDir: dir,
  joinCode: '654321',
  publicDir: path.resolve(process.env.LINCHUAN_PUBLIC_DIR || 'dist'),
});
await server.start();
const base = `http://127.0.0.1:${server.getPort()}`;
const evidenceDir =
  process.env.LINCHUAN_QA_DIR || path.join(os.tmpdir(), 'linchuan-ui-evidence');
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const recordErrors = (page: Page) =>
  page.on('pageerror', (error) => errors.push(error.message));
const join = async (page: Page, name: string, type = '电脑') => {
  recordErrors(page);
  await page.goto(base);
  await page.getByLabel('设备名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: type, exact: true }).click();
  await page.getByLabel('6 位连接码').fill('654321');
  await page.getByRole('button', { name: '进入聊天室' }).click();
  await expect(
    page.getByRole('heading', { name: '公共聊天室', exact: true }),
  ).toBeVisible();
};

try {
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
  const pa = await a.newPage();
  const pb = await b.newPage();
  const pc = await c.newPage();
  recordErrors(pa);
  await pa.goto(base);
  await pa.getByLabel('6 位连接码').fill('000000');
  await pa.getByRole('button', { name: '进入聊天室' }).click();
  await expect(pa.getByRole('alert')).toBeVisible();
  await join(pa, '我的电脑');
  await join(pb, '书房电脑');
  await join(pc, '我的手机', '手机');
  const theme = (page: Page) => page.getByLabel('外观主题');
  assert.equal(await theme(pa).getAttribute('data-value'), 'system');
  await selectMenu(pa, '外观主题', '深色');
  await expect(pa.locator('html')).toHaveAttribute('data-theme', 'dark');
  await selectMenu(pa, '外观主题', '浅色');
  await expect(pa.locator('html')).toHaveAttribute('data-theme', 'light');
  await selectMenu(pa, '外观主题', '跟随系统');
  await pa.emulateMedia({ colorScheme: 'dark' });
  await expect(pa.locator('html')).toHaveAttribute('data-theme', 'dark');
  await pa.emulateMedia({ colorScheme: 'light' });
  await expect(pa.locator('html')).toHaveAttribute('data-theme', 'light');
  await selectMenu(pb, '外观主题', '深色');
  await pb.emulateMedia({ colorScheme: 'light' });
  await expect(pb.locator('html')).toHaveAttribute('data-theme', 'dark');
  await pb.reload();
  await expect(
    pb.getByRole('heading', { name: '公共聊天室', exact: true }),
  ).toBeVisible();
  assert.equal(await theme(pb).getAttribute('data-value'), 'dark');
  await expect(pb.locator('html')).toHaveAttribute('data-theme', 'dark');
  await selectMenu(pc, '外观主题', '深色');
  await expect(pc.locator('html')).toHaveAttribute('data-theme', 'dark');
  const themeTab = await a.newPage();
  await themeTab.goto(base);
  assert.equal(await theme(themeTab).getAttribute('data-value'), 'system');
  await selectMenu(pa, '外观主题', '浅色');
  await expect
    .poll(() => theme(themeTab).getAttribute('data-value'))
    .toBe('light');
  await expect(themeTab.locator('html')).toHaveAttribute('data-theme', 'light');
  await themeTab.close();
  const bootstrapContext = await browser.newContext({
    colorScheme: 'dark',
    locale: 'zh-CN',
    viewport: { width: 900, height: 700 },
  });
  const bootstrapPage = await bootstrapContext.newPage();
  await bootstrapPage.route('**/assets/*.js', (route) => {
    setTimeout(() => void route.continue(), 1000);
  });
  await bootstrapPage.goto(base, { waitUntil: 'domcontentloaded' });
  assert.equal(
    await bootstrapPage.locator('html').getAttribute('data-theme'),
    'dark',
  );
  await bootstrapContext.close();
  await fs.mkdir(evidenceDir, { recursive: true });
  await pa.screenshot({
    path: path.join(evidenceDir, 'theme-light-desktop.png'),
    fullPage: true,
  });
  await pb.screenshot({
    path: path.join(evidenceDir, 'theme-dark-desktop.png'),
    fullPage: true,
  });
  await pc.screenshot({
    path: path.join(evidenceDir, 'theme-dark-mobile.png'),
    fullPage: true,
  });
  await expect(pa.getByRole('heading', { name: '在线设备 3' })).toBeVisible();
  await expect(pa.getByLabel('本机连接码')).toHaveText('654321');
  await expect(pa.getByRole('button', { name: '书房电脑 在线' })).toBeVisible();
  const send = async (page: Page, text: string) => {
    await page.getByRole('textbox', { name: '输入消息' }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
  };
  await send(pb, '照片已经整理好了');
  await expect(pa.getByText('照片已经整理好了', { exact: true })).toBeVisible();
  await expect(pc.getByText('照片已经整理好了', { exact: true })).toBeVisible();
  await send(pa, '好，直接拖进来就可以。');
  await send(pc, '收到，我把手机上的也传过来。');
  await expect(
    pb.getByText('收到，我把手机上的也传过来。', { exact: true }),
  ).toBeVisible();

  await pa.getByRole('button', { name: '书房电脑 在线' }).click();
  await send(pa, '私聊测试：只给书房电脑');
  await expect(
    pc.getByText('私聊测试：只给书房电脑', { exact: true }),
  ).toHaveCount(0);
  await pb.getByRole('button', { name: /我的电脑 在线/ }).click();
  await expect(
    pb.getByText('私聊测试：只给书房电脑', { exact: true }),
  ).toBeVisible();
  await pa.reload();
  await expect(
    pa.getByRole('heading', { name: '公共聊天室', exact: true }),
  ).toBeVisible();
  await pa.getByRole('button', { name: '书房电脑 在线' }).click();
  await expect(
    pa.getByText('私聊测试：只给书房电脑', { exact: true }),
  ).toBeVisible();

  const bytes = crypto.randomBytes(2 * 1024 * 1024);
  await pa.getByLabel('文件选择器').setInputFiles({
    name: '旅行照片.zip',
    mimeType: 'application/zip',
    buffer: bytes,
  });
  await expect(pb.getByRole('link', { name: '下载 旅行照片.zip' })).toBeVisible(
    { timeout: 20000 },
  );
  const downloaded = pb.waitForEvent('download');
  await pb.getByRole('link', { name: '下载 旅行照片.zip' }).click();
  const download = await downloaded;
  const downloadedPath = await download.path();
  assert.ok(downloadedPath);
  const actual = await fs.readFile(downloadedPath);
  assert.equal(
    crypto.createHash('sha256').update(actual).digest('hex'),
    crypto.createHash('sha256').update(bytes).digest('hex'),
  );
  const href = await pb
    .getByRole('link', { name: '下载 旅行照片.zip' })
    .getAttribute('href');
  assert.ok(href);
  const denied = await c.request.get(`${base}${href}`);
  assert.equal(denied.status(), 404);
  pa.once('dialog', (dialog) => void dialog.accept());
  await pa.getByRole('button', { name: '删除文件', exact: true }).click();
  await expect(pa.getByRole('link', { name: '下载 旅行照片.zip' })).toHaveCount(
    0,
  );
  await expect(
    pb.getByRole('link', { name: '下载 旅行照片.zip' }),
  ).toBeVisible();
  assert.equal((await b.request.get(`${base}${href}`)).status(), 200);
  await pa.reload();
  await pa.getByRole('button', { name: '书房电脑 在线' }).click();
  await expect(pa.getByRole('link', { name: '下载 旅行照片.zip' })).toHaveCount(
    0,
  );
  await expect(
    pb.getByRole('button', { name: '删除文件', exact: true }),
  ).toBeVisible();

  await pa.getByRole('button', { name: /公共聊天室 发给所有在线设备/ }).click();
  await pb.getByRole('button', { name: /公共聊天室 发给所有在线设备/ }).click();
  await pa.getByLabel('文件选择器').setInputFiles({
    name: '旅行照片.zip',
    mimeType: 'application/zip',
    buffer: bytes,
  });
  await expect(pc.getByRole('link', { name: '下载 旅行照片.zip' })).toBeVisible(
    { timeout: 20000 },
  );
  await expect(
    pc.getByRole('link', { name: '下载 旅行照片.zip' }),
  ).toBeVisible();
  await pa.getByRole('textbox', { name: '输入消息' }).fill('第一行\n第二行');
  await pa.getByRole('textbox', { name: '输入消息' }).press('Enter');
  await expect(pb.getByText('第一行\n第二行', { exact: true })).toBeVisible();
  pb.once('dialog', (dialog) => void dialog.accept());
  await pb
    .locator('.message-row')
    .filter({ hasText: '第一行\n第二行' })
    .getByRole('button', { name: '删除消息', exact: true })
    .click();
  await expect(pb.getByText('第一行\n第二行', { exact: true })).toHaveCount(0);
  await expect(pa.getByText('第一行\n第二行', { exact: true })).toBeVisible();
  await pb.reload();
  await expect(pb.getByText('第一行\n第二行', { exact: true })).toHaveCount(0);
  const longText = '复制按钮应放在消息右下角，方便阅读完后操作。'.repeat(12);
  await send(pb, longText);
  const bubble = pa.locator('.text-bubble').filter({ hasText: longText });
  await bubble.hover();
  const copyBox = await bubble
    .getByRole('button', { name: '复制消息' })
    .boundingBox();
  const bubbleBox = await bubble.boundingBox();
  const deleteBox = await bubble
    .getByRole('button', { name: '删除消息', exact: true })
    .boundingBox();
  assert.ok(copyBox && deleteBox && bubbleBox);
  assert.ok(
    Math.abs(
      bubbleBox.x + bubbleBox.width - deleteBox.x - deleteBox.width - 5,
    ) < 2,
  );
  assert.ok(
    Math.abs(
      bubbleBox.y + bubbleBox.height - deleteBox.y - deleteBox.height - 5,
    ) < 2,
  );
  assert.ok(Math.abs(copyBox.y - deleteBox.y) < 1);
  assert.ok(Math.abs(deleteBox.x - copyBox.x - copyBox.width - 4) < 1);
  const secondTab = await a.newPage();
  await secondTab.goto(base);
  await expect(
    secondTab.getByRole('heading', { name: '公共聊天室', exact: true }),
  ).toBeVisible();
  await secondTab.close();
  await expect(pa.getByRole('heading', { name: '在线设备 3' })).toBeVisible();

  await pc.getByRole('button', { name: '打开设备列表' }).click();
  await expect(pc.getByRole('button', { name: '书房电脑 在线' })).toBeVisible();
  await pc.getByRole('button', { name: '书房电脑 在线' }).click();
  await expect(
    pc.getByRole('heading', { name: '书房电脑', exact: true }),
  ).toBeVisible();
  await pc.getByRole('button', { name: '打开设备列表' }).click();
  await pc.getByRole('button', { name: /公共聊天室 发给所有在线设备/ }).click();
  await pc.getByRole('button', { name: '添加设备' }).click();
  await expect(pc.getByRole('dialog', { name: '添加设备' })).toBeVisible();
  await expect(pc.getByRole('img', { name: /扫码打开/ })).toBeVisible();
  await pc.getByRole('button', { name: '关闭添加设备' }).click();
  const videoFixture = await pa.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#778fcb';
    context.fillRect(0, 0, 320, 180);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const recorded = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });
    recorder.start();
    setTimeout(() => {
      context.fillStyle = '#bbdbef';
      context.fillRect(30, 30, 260, 120);
    }, 150);
    setTimeout(() => recorder.stop(), 650);
    const blob = await recorded;
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await pc.getByLabel('相册照片视频选择器').setInputFiles([
    {
      name: '手机照片.png',
      mimeType: 'image/png',
      buffer: await sharp({
        create: { width: 900, height: 600, channels: 3, background: '#779ecb' },
      })
        .png()
        .toBuffer(),
    },
    {
      name: '第二张照片.png',
      mimeType: 'image/png',
      buffer: await sharp({
        create: { width: 800, height: 600, channels: 3, background: '#dbaa8f' },
      })
        .png()
        .toBuffer(),
    },
    {
      name: '手机视频.webm',
      mimeType: 'video/webm',
      buffer: Buffer.from(videoFixture),
    },
  ]);
  await expect(
    pa.getByRole('link', { name: '下载 手机照片.png' }),
  ).toBeVisible();
  await expect(pc.getByRole('link', { name: '下载 手机照片.png' })).toHaveCount(
    0,
  );
  await expect(
    pc.getByRole('link', { name: '下载 手机视频.webm' }),
  ).toHaveCount(0);
  const photoPreview = pa.getByRole('img', { name: '预览 手机照片.png' });
  await expect(photoPreview).toBeVisible();
  await expect
    .poll(() =>
      photoPreview.evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await pa.getByRole('button', { name: '查看大图 手机照片.png' }).click();
  const gallery = pa.getByRole('dialog', { name: '图片查看器' });
  await expect(gallery).toBeVisible();
  const currentImage = gallery.locator(
    '.yarl__slide_current .yarl__slide_image',
  );
  await expect
    .poll(() =>
      currentImage.evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(currentImage).toHaveAttribute('src', /\/media$/);
  assert.equal(
    await currentImage.evaluate((img) =>
      img.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      ),
    ),
    true,
  );
  const zoomWrapper = gallery.locator(
    '.yarl__slide_current .yarl__slide_wrapper',
  );
  const originalTransform = await zoomWrapper.getAttribute('style');
  await currentImage.hover();
  await pa.mouse.wheel(0, -450);
  await expect
    .poll(() => zoomWrapper.getAttribute('style'))
    .not.toBe(originalTransform);
  const zoomedTransform = await zoomWrapper.getAttribute('style');
  const imageBox = await currentImage.boundingBox();
  assert.ok(imageBox);
  await pa.mouse.move(
    imageBox.x + imageBox.width / 2,
    imageBox.y + imageBox.height / 2,
  );
  await pa.mouse.down();
  await pa.mouse.move(
    imageBox.x + imageBox.width / 2 + 80,
    imageBox.y + imageBox.height / 2 + 45,
    { steps: 5 },
  );
  await pa.mouse.up();
  await expect
    .poll(() => zoomWrapper.getAttribute('style'))
    .not.toBe(zoomedTransform);
  await pa.getByRole('button', { name: '关闭图片预览' }).click();
  await pa.getByRole('button', { name: '查看大图 手机照片.png' }).click();
  await gallery.getByRole('button', { name: '下一张', exact: true }).click();
  await expect(currentImage).toHaveAttribute('alt', '第二张照片.png');
  await pa.keyboard.press('ArrowLeft');
  await expect(currentImage).toHaveAttribute('alt', '手机照片.png');
  await pa.keyboard.press('ArrowRight');
  await expect(currentImage).toHaveAttribute('alt', '第二张照片.png');
  await expect
    .poll(() =>
      currentImage.evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBe(800);
  await pa.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await fs.mkdir(evidenceDir, { recursive: true });
  await pa.screenshot({
    path: path.join(evidenceDir, 'gallery-desktop.png'),
    fullPage: true,
  });
  await pa.getByRole('button', { name: '关闭图片预览' }).click();
  await expect(
    pa.getByRole('link', { name: '下载 手机视频.webm' }),
  ).toBeVisible();
  const player = pa.getByLabel('播放 手机视频.webm');
  await player.evaluate((video) => {
    const element = video as HTMLVideoElement;
    element.muted = true;
    return element.play();
  });
  await expect
    .poll(() =>
      player.evaluate((video) => (video as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0);
  await player.evaluate((video) => (video as HTMLVideoElement).pause());
  const mobilePlayer = pc.getByLabel('播放 手机视频.webm');
  await mobilePlayer.evaluate((video) => {
    const element = video as HTMLVideoElement;
    element.muted = true;
    return element.play();
  });
  await expect
    .poll(() =>
      mobilePlayer.evaluate((video) => (video as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0);
  await mobilePlayer.evaluate((video) => (video as HTMLVideoElement).pause());
  await pc.getByRole('button', { name: '查看大图 手机照片.png' }).click();
  const mobileGallery = pc.getByRole('dialog', { name: '图片查看器' });
  const mobileImage = mobileGallery.locator(
    '.yarl__slide_current .yarl__slide_image',
  );
  await expect(mobileImage).toBeVisible();
  const mobileZoom = mobileGallery.locator(
    '.yarl__slide_current .yarl__slide_wrapper',
  );
  const touch = await c.newCDPSession(pc);
  const beforePinch = await mobileZoom.getAttribute('style');
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 165, y: 400, id: 1 },
      { x: 225, y: 400, id: 2 },
    ],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: 85, y: 400, id: 1 },
      { x: 305, y: 400, id: 2 },
    ],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect
    .poll(() => mobileZoom.getAttribute('style'))
    .not.toBe(beforePinch);
  await pc.getByRole('button', { name: '关闭图片预览' }).click();
  await pc.getByRole('button', { name: '查看大图 手机照片.png' }).click();
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 330, y: 400, id: 1 }],
  });
  for (const x of [280, 220, 160, 90])
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 400, id: 1 }],
    });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(mobileImage).toHaveAttribute('alt', '第二张照片.png');
  await expect
    .poll(() =>
      mobileImage.evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBe(800);
  await pc.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await pc.screenshot({
    path: path.join(evidenceDir, 'gallery-mobile.png'),
    fullPage: true,
  });
  await pc.getByRole('button', { name: '关闭图片预览' }).click();
  await touch.detach();
  const photoRow = pc
    .locator('.message-row')
    .filter({ hasText: '手机照片.png' });
  await photoRow.getByRole('button', { name: '保存', exact: true }).click();
  const saveGuide = pc.getByRole('dialog', { name: '保存到手机' });
  await expect(saveGuide).toBeVisible();
  await expect(
    saveGuide.getByRole('link', { name: '打开原图' }),
  ).toHaveAttribute('href', /\/media$/);
  await pc.getByRole('button', { name: '关闭手机保存说明' }).click();
  await pa.screenshot({
    path: path.join(evidenceDir, 'preview-desktop.png'),
    fullPage: true,
  });
  await pc.screenshot({
    path: path.join(evidenceDir, 'preview-mobile.png'),
    fullPage: true,
  });
  pc.on('dialog', (dialog) => void dialog.accept());
  for (const name of ['手机照片.png', '第二张照片.png', '手机视频.webm']) {
    await pc
      .locator('.message-row')
      .filter({ hasText: name })
      .getByRole('button', { name: '删除文件', exact: true })
      .click();
  }
  await expect(
    pc.locator('.message-row').filter({ hasText: '手机视频.webm' }),
  ).toHaveCount(0);
  await expect(
    pa.locator('.message-row').filter({ hasText: '手机视频.webm' }),
  ).toBeVisible();
  await pc.reload();
  await expect(
    pc.locator('.message-row').filter({ hasText: '手机视频.webm' }),
  ).toHaveCount(0);
  assert.equal(
    await pc.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );

  await pa.getByRole('button', { name: '设备设置', exact: true }).click();
  await selectMenu(pa, '设备类型', '手机');
  await expect(pa.getByLabel('设备类型')).toHaveAttribute(
    'data-value',
    'phone',
  );
  await selectMenu(pa, '设备类型', '电脑');
  await pa.getByLabel('设备名称', { exact: true }).fill('客厅电脑');
  await pa.getByRole('button', { name: '保存修改' }).click();
  if (await pa.getByRole('button', { name: '关闭提示' }).isVisible())
    await pa.getByRole('button', { name: '关闭提示' }).click();
  await expect(pb.getByRole('button', { name: '客厅电脑 在线' })).toBeVisible();
  await pa.getByRole('button', { name: '设备设置', exact: true }).click();
  await pa.getByLabel('设备名称', { exact: true }).fill('我的电脑');
  await pa.getByRole('button', { name: '保存修改' }).click();
  if (await pa.getByRole('button', { name: '关闭提示' }).isVisible())
    await pa.getByRole('button', { name: '关闭提示' }).click();
  await pa.screenshot({
    path: path.join(evidenceDir, 'desktop.png'),
    fullPage: true,
  });
  await pc.screenshot({
    path: path.join(evidenceDir, 'mobile.png'),
    fullPage: true,
  });
  await pb.close();
  await expect(
    pa.getByRole('button', { name: '书房电脑 离线 · 可留言' }),
  ).toBeVisible();
  await pa.getByRole('button', { name: '书房电脑 离线 · 可留言' }).click();
  await send(pa, '离线留言测试');
  const reconnected = await b.newPage();
  await reconnected.goto(base);
  await reconnected.getByRole('button', { name: /我的电脑 在线/ }).click();
  await expect(
    reconnected.getByText('离线留言测试', { exact: true }),
  ).toBeVisible();
  await reconnected
    .getByRole('button', { name: '设备设置', exact: true })
    .click();
  await reconnected.getByRole('button', { name: '退出当前设备' }).click();
  await expect(
    reconnected.getByRole('heading', { name: '连接你的设备' }),
  ).toBeVisible();
  const oldCode = server.getJoinCode();
  await reconnected.getByLabel('6 位连接码').fill(oldCode);
  await reconnected
    .getByRole('button', { name: '刷新连接码', exact: true })
    .click();
  await expect(reconnected.getByLabel('本机连接码')).not.toHaveText(oldCode);
  await expect(
    reconnected.getByRole('heading', { name: '连接你的设备' }),
  ).toBeVisible();
  await reconnected.getByRole('button', { name: '本机使用此码' }).click();
  await reconnected.getByRole('button', { name: '进入聊天室' }).click();
  await expect(
    reconnected.getByRole('heading', { name: '公共聊天室', exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    '浏览器验证通过：三个独立设备会话、本机连接码、公共聊天、私聊隔离、2MB文件哈希、下载Cookie与ACL、双方删除按钮及仅本设备删除、刷新保持删除、相册图片视频多选、原图预览/右键未阻止、滚轮缩放/拖动/左右切图、保存到手机说明、复制按钮右下角、桌面手机视频真实播放、多标签在线、手机抽屉/二维码/无横向溢出、改名、离线留言、退出、零页面异常。',
  );
} finally {
  await browser.close();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
}
