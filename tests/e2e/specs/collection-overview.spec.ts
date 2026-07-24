import * as path from 'path';
import type { Page, Frame } from '@playwright/test';
import { test, expect } from '../utils/fixtures';
import { openBrunoSidebar, importCollection } from '../utils/page/actions';
import { buildCommonLocators } from '../utils/page/locators';

/**
 * Open the collection settings dashboard (Overview tab) by clicking the
 * collection's name in the sidebar.
 *
 * @returns The collection-settings editor webview Frame.
 */
async function openCollectionSettings(
  page: Page,
  sidebar: Frame,
  collectionName: string
): Promise<Frame> {
  const collectionName_ = buildCommonLocators(sidebar).sidebar.collectionName(collectionName);
  await expect(collectionName_).toBeVisible({ timeout: 5_000 });
  await collectionName_.click();

  // Wait for the collection-settings frame to appear.
  const timeout = 5000;
  const deadline = Date.now() + timeout;
  let editor: Frame | undefined;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === sidebar || frame === page.mainFrame()) continue;
      try {
        const has = await buildCommonLocators(frame).collectionSettings.container().count();
        if (has > 0) { editor = frame; break; }
      } catch (err) {
        console.debug('Frame detached during collection-settings lookup:', err);
      }
    }
    if (editor) break;
    await page.waitForTimeout(500);
  }

  if (!editor) throw new Error(`Collection settings frame not found within ${timeout}ms`);
  await expect(buildCommonLocators(editor).collectionSettings.container()).toBeVisible({ timeout: 5000 });

  return editor;
}

test.describe('Collection overview', () => {
  test('Collection settings Overview shows the correct request count', async ({ page, tmpDir }) => {
    // Import a fixture with a known request count (2 root requests + 1 request
    // inside a folder = 3) rather than creating requests through the UI.
    const sidebar = await openBrunoSidebar(page);
    const fixturePath = path.resolve(__dirname, '../fixtures/request-count-collection.json');
    const collectionName = 'Request Count Collection';

    await importCollection(page, sidebar, fixturePath, tmpDir, collectionName);

    const settings = await openCollectionSettings(page, sidebar, collectionName);

    // The Overview's Requests line must report all 3 requests (including the one
    // nested in a folder).
    const requestsInfo = buildCommonLocators(settings).collectionSettings.requestsInfo();
    await expect(requestsInfo).toHaveText('3 requests in collection', { timeout: 5_000 });

    // Lazily-scanned requests are metadata-only (partial) until opened and must not be reported as "not loaded".
    const requestsNotLoaded = buildCommonLocators(settings).collectionSettings.requestsNotLoaded();
    await expect(requestsNotLoaded).toHaveCount(0);
  });
});
