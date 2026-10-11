import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { detectLanguage } from '../src/i18n';

const catalogs = Object.fromEntries(
  ['zh', 'en', 'ko', 'ja'].map((lang) => [
    lang,
    JSON.parse(fs.readFileSync(`src/locales/${lang}.json`, 'utf8')) as Record<
      string,
      string
    >,
  ]),
);
const variables = (text: string) =>
  [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();

test('native Windows UI uses the same complete language catalogs', () => {
  for (const file of fs
    .readdirSync('native/Linchuan.Desktop')
    .filter((name) => name.endsWith('.cs'))) {
    const code = fs.readFileSync(
      path.join('native/Linchuan.Desktop', file),
      'utf8',
    );
    for (const match of code.matchAll(
      /(?:L\.T|Ui\.(?:Text|Button|AsyncButton)|Dialog)\("([^"\n]+)"/g,
    )) {
      if (/[\u3400-\u9fff]/.test(match[1]))
        assert.ok(Object.hasOwn(catalogs.zh, match[1]), `${file}: ${match[1]}`);
    }
  }
});

test('four languages have complete catalogs and matching interpolation variables', () => {
  const keys = Object.keys(catalogs.zh).sort();
  for (const [language, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, language);
    for (const key of keys) {
      assert.ok(catalog[key].trim(), `${language}: ${key}`);
      assert.deepEqual(
        variables(catalog[key]),
        variables(key),
        `${language}: ${key}`,
      );
    }
  }
});

test('language detection follows browser preference order, including region variants', () => {
  assert.equal(detectLanguage(['ko-KR', 'en-US']), 'ko');
  assert.equal(detectLanguage(['ja-JP']), 'ja');
  assert.equal(detectLanguage(['zh-TW']), 'zh');
  assert.equal(detectLanguage(['fr-FR', 'en-GB', 'zh-CN']), 'en');
  assert.equal(detectLanguage(['fr-FR', 'de-DE']), 'en');
});

test('UI text uses translation keys, including dialogs and accessible labels', () => {
  const files = [
    'src/App.tsx',
    ...fs
      .readdirSync('src/components')
      .filter(
        (file) => file.endsWith('.tsx') && file !== 'LanguageSelector.tsx',
      )
      .map((file) => path.join('src/components', file)),
  ];
  const missing: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isJsxText(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /[\u3400-\u9fff]/.test(node.getText(source))
      ) {
        let parent: ts.Node | undefined = node.parent;
        let translated = false;
        while (parent && !ts.isJsxElement(parent)) {
          if (
            ts.isCallExpression(parent) &&
            parent.expression.getText(source) === 't'
          ) {
            translated = true;
            break;
          }
          parent = parent.parent;
        }
        if (!translated)
          missing.push(`${file}: ${node.getText(source).trim()}`);
        if (ts.isStringLiteral(node) && translated)
          assert.ok(
            Object.hasOwn(catalogs.zh, node.text),
            `Missing key: ${node.text}`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(missing, []);
});
