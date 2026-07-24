import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../utils/fixtures';
import { openBrunoSidebar, createCollection, openRequest, sendRequest } from '../utils/page/actions';

const TEST_SERVER = 'http://127.0.0.1:8081';

function findCollectionDir(root: string): string {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === 'bruno.json')) return dir;
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }
  }
  throw new Error(`No collection (bruno.json) found under ${root}`);
}

test.describe('HTML response preview', () => {
  test('base href uses the interpolated request URL when the URL contains a variable', async ({ page, tmpDir }) => {
    const sidebar = await openBrunoSidebar(page);
    const collectionName = 'Html Preview';

    await createCollection(page, sidebar, collectionName, tmpDir, 'bru');

    const collectionDir = findCollectionDir(tmpDir);
    fs.mkdirSync(path.join(collectionDir, 'environments'), { recursive: true });
    fs.writeFileSync(path.join(collectionDir, 'environments', 'Local.bru'), `vars {\n  host: ${TEST_SERVER}\n}\n`, 'utf8');
    // The request URL uses the {{host}} variable and returns an HTML page.
    fs.writeFileSync(path.join(collectionDir, 'Page.bru'), [
      'meta {', '  name: Page', '  type: http', '  seq: 1', '}', '',
      'get {', '  url: {{host}}/htmlpage', '  body: none', '  auth: inherit', '}', ''
    ].join('\n'), 'utf8');

    const editor = await openRequest(page, sidebar, collectionName, 'Page');

    await editor.locator('[data-testid="environment-selector-trigger"]').click();
    await editor.locator('.dropdown-item').filter({ hasText: 'Local' }).first().click();

    await sendRequest(editor, 200);

    // text/html auto-renders the preview iframe with an injected <base href>. Read its srcdoc and
    // assert the base href is the interpolated URL, not the raw {{host}} form.
    const previewFrame = editor.locator('iframe');
    await expect(previewFrame).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await previewFrame.getAttribute('srcdoc')) || '', { timeout: 15_000 })
      .toContain(`<base href="${TEST_SERVER}/htmlpage">`);
    const srcdoc = (await previewFrame.getAttribute('srcdoc')) || '';
    expect(srcdoc).not.toContain('{{host}}');
  });
});
