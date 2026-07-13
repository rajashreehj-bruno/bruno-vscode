import { Frame, Page } from '@playwright/test';

/**
 * Centralised Playwright locators for the e2e suite.
 *
 * In bruno-vscode the Bruno UI runs inside VS Code webview iframes, so the factory
 * takes the relevant `Frame` (or `Page`) instead of the top-level page.
 */
export type FrameLike = Frame | Page;

export const buildCommonLocators = (frame: FrameLike) => ({
  sidebar: {
    // The sidebar renders `#sidebar-collection-name` for each collection.
    collectionName: (name: string) =>
      frame.locator('#sidebar-collection-name').filter({ hasText: name })
  },
  collectionSettings: {
    container: () => frame.getByTestId('collection-settings'),
    // Overview → Requests line, e.g. "2 requests in collection".
    requestsInfo: () => frame.getByTestId('collection-requests-count')
  }
});
