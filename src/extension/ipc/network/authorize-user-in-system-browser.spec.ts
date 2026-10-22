import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  createOAuth2UriHandler,
  cancelAuthorization,
  getOAuth2AuthorizationCode,
  getOAuth2ImplicitToken,
  withEditorScheme
} from './authorize-user-in-system-browser';

const env = vscode.env as unknown as { uriScheme: string; openExternal: ReturnType<typeof vi.fn> };

const baseOptions = {
  authorizationUrl: 'https://idp.example.com/authorize',
  callbackUrl: 'https://oauth.usebruno.com/vscode/callback',
  clientId: 'client',
  state: 'abc123'
};

const openedState = (): string | null => {
  const uri = env.openExternal.mock.calls.at(-1)?.[0];
  return new URL(uri.toString()).searchParams.get('state');
};

const callback = (query: string) => createOAuth2UriHandler().handleUri({ query, fragment: '' } as vscode.Uri);

describe('withEditorScheme', () => {
  afterEach(() => {
    env.uriScheme = 'vscode';
  });

  it('leaves state unchanged in VS Code', () => {
    expect(withEditorScheme('abc123')).toBe('abc123');
  });

  it('prefixes state with the editor scheme in other editors', () => {
    env.uriScheme = 'cursor';
    expect(withEditorScheme('abc123')).toBe('bruno.cursor.abc123');
    env.uriScheme = 'vscode-insiders';
    expect(withEditorScheme('abc123')).toBe('bruno.vscode-insiders.abc123');
  });

  it('ignores schemes that are not safe to put in the page redirect', () => {
    env.uriScheme = 'java script';
    expect(withEditorScheme('abc123')).toBe('abc123');
  });
});

describe('browser authorization state round-trip', () => {
  beforeEach(() => {
    env.openExternal.mockClear();
  });

  afterEach(() => {
    cancelAuthorization();
    env.uriScheme = 'vscode';
  });

  it('sends unprefixed state and accepts the callback in VS Code', async () => {
    const result = getOAuth2AuthorizationCode(baseOptions);
    expect(openedState()).toBe('abc123');

    callback('code=the-code&state=abc123');
    await expect(result).resolves.toMatchObject({ authorizationCode: 'the-code' });
  });

  it('sends scheme-prefixed state and accepts the callback in Cursor (authorization code)', async () => {
    env.uriScheme = 'cursor';
    const result = getOAuth2AuthorizationCode(baseOptions);
    expect(openedState()).toBe('bruno.cursor.abc123');

    callback('code=the-code&state=bruno.cursor.abc123');
    await expect(result).resolves.toMatchObject({ authorizationCode: 'the-code' });
  });

  it('sends scheme-prefixed state and accepts the callback in Cursor (implicit)', async () => {
    env.uriScheme = 'cursor';
    const result = getOAuth2ImplicitToken(baseOptions);
    expect(openedState()).toBe('bruno.cursor.abc123');

    callback('access_token=tok&token_type=Bearer&state=bruno.cursor.abc123');
    await expect(result).resolves.toMatchObject({ implicitTokens: { access_token: 'tok' } });
  });

  it('rejects a callback carrying the unprefixed state in Cursor', async () => {
    env.uriScheme = 'cursor';
    const result = getOAuth2AuthorizationCode(baseOptions);

    callback('code=the-code&state=abc123');
    await expect(result).rejects.toThrow('state mismatch');
  });
});
