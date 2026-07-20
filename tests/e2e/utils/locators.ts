import { Frame, Page } from '@playwright/test';

// Centralised Playwright locators. The Bruno UI runs inside VS Code webview
// iframes, so the factory takes a Frame (or Page).
export type FrameLike = Frame | Page;

export const buildCommonLocators = (frame: FrameLike) => ({
  sidebar: {
    collectionName: (name: string) =>
      frame.getByTestId('sidebar-collection-row').filter({ hasText: name })
  },
  collectionSettings: {
    container: () => frame.getByTestId('collection-settings'),
    requestsInfo: () => frame.getByTestId('collection-requests-count'),
    requestsNotLoaded: () => frame.getByTestId('collection-requests-not-loaded')
  },
  requestUrl: {
    editor: () => frame.locator('#request-url'),
    // A `:param` token highlighted in the URL editor.
    pathParamToken: (name: string) =>
      frame
        .locator('#request-url .CodeMirror span.cm-variable-valid, #request-url .CodeMirror span.cm-variable-invalid')
        .filter({ hasText: name })
        .first()
  },
  // Var-info hover popover shown over a highlighted token.
  varPopover: {
    container: () => frame.locator('.CodeMirror-brunoVarInfo'),
    editableDisplay: () => frame.locator('.CodeMirror-brunoVarInfo .var-value-editable-display'),
    editor: () => frame.locator('.CodeMirror-brunoVarInfo .var-value-editor .CodeMirror'),
    editorFocused: () => frame.locator('.CodeMirror-brunoVarInfo .var-value-editor .CodeMirror-focused'),
    editorLine: () => frame.locator('.CodeMirror-brunoVarInfo .var-value-editor .CodeMirror-line').first()
  },
  paramsTable: {
    // Value cell of the path-params table.
    pathValueCell: () =>
      frame
        .getByTestId('path-params-table')
        .getByTestId('column-value')
        .locator('.CodeMirror-line')
        .first()
  }
});
