import * as fs from 'fs';
import * as path from 'path';
import { stringifyRequest, parseCollection, stringifyCollection } from '@usebruno/filestore';
import { test, expect } from '../../utils/fixtures';
import {
  openBrunoSidebar,
  createCollection,
  findCollectionDir,
  openRequest,
  sendRequest,
  closeEditorTab,
  selectResponsePaneTab
} from '../../utils/page/actions';
import { buildCommonLocators } from '../../utils/page/locators';
import { startNtlmServer, type NtlmEndpoint } from '../../server/auth/ntlm';

const USERNAME = 'ntlmtest';
const PASSWORD = 'Br!unoNtlm';

interface RequestSpec {
  name: string;
  url: string;
  method?: 'GET' | 'POST';
  auth?: 'ntlm' | 'inherit';
  password?: string;
  headers?: Record<string, string>;
  jsonBody?: string;
}

const ntlmAuth = (password: string) => ({ mode: 'ntlm', ntlm: { username: USERNAME, password, domain: '' } });

function writeRequest(collectionDir: string, { name, url, method = 'GET', auth = 'ntlm', password = PASSWORD, headers = {}, jsonBody }: RequestSpec): void {
  const yml = stringifyRequest({
    type: 'http-request',
    name,
    seq: 1,
    request: {
      method,
      url,
      headers: Object.entries(headers).map(([key, value]) => ({ name: key, value, enabled: true })),
      body: jsonBody ? { mode: 'json', json: jsonBody } : { mode: 'none' },
      auth: auth === 'ntlm' ? ntlmAuth(password) : { mode: auth }
    }
  } as Parameters<typeof stringifyRequest>[0], { format: 'yml' });

  fs.writeFileSync(path.join(collectionDir, `${name}.yml`), yml, 'utf8');
}

function setCollectionNtlmAuth(collectionDir: string): void {
  const configPath = path.join(collectionDir, 'opencollection.yml');
  const { collectionRoot, brunoConfig } = parseCollection(fs.readFileSync(configPath, 'utf8'), { format: 'yml' });
  collectionRoot.request = { ...collectionRoot.request, auth: ntlmAuth(PASSWORD) };
  fs.writeFileSync(configPath, stringifyCollection(collectionRoot, brunoConfig, { format: 'yml' }), 'utf8');
}

// Each step gets its own server so the requests it records belong to that step alone.
async function withNtlmServer(options: Parameters<typeof startNtlmServer>[0], run: (endpoint: NtlmEndpoint) => Promise<void>): Promise<void> {
  const endpoint = await startNtlmServer({ password: PASSWORD, ...options });
  try {
    await run(endpoint);
  } finally {
    await endpoint.close();
  }
}

test.describe('NTLM auth', () => {
  test('authenticates requests with NTLM', async ({ page, tmpDir }) => {
    const collectionName = 'NTLM';
    const sidebar = await openBrunoSidebar(page);
    await createCollection(page, sidebar, collectionName, tmpDir);
    const collectionDir = findCollectionDir(tmpDir, 'opencollection.yml');
    // Each request opens in its own webview, which would cover the next one's Send button, so close it first.
    let openTab: string | undefined;
    const sendTo = async (request: RequestSpec, expectedStatus: number) => {
      if (openTab) {
        await closeEditorTab(page, openTab);
      }
      openTab = request.name;
      writeRequest(collectionDir, request);
      const editor = await openRequest(page, sidebar, collectionName, request.name);
      await sendRequest(editor, expectedStatus);
      return editor;
    };

    await test.step('negotiates and authenticates over a single connection', async () => {
      await withNtlmServer({}, async (endpoint) => {
        const editor = await sendTo({ name: 'api', url: `${endpoint.baseUrl}/api` }, 200);
        await expect(buildCommonLocators(editor).response.previewContainer()).toContainText('authenticated');

        expect(endpoint.messageTypesSeen()).toEqual([null, 1, 3]);
        expect(endpoint.requests.map((request) => request.provedPassword)).toEqual([undefined, undefined, true]);
        expect(endpoint.connectionsUsed()).toBe(1);
      });
    });

    await test.step('is refused when the password is wrong', async () => {
      await withNtlmServer({}, async (endpoint) => {
        await sendTo({ name: 'wrong-password', url: `${endpoint.baseUrl}/api`, password: 'notThePassword' }, 401);

        expect(endpoint.messageTypesSeen()).toEqual([null, 1, 3]);
        expect(endpoint.requests.map((request) => request.provedPassword)).toEqual([undefined, undefined, false]);
      });
    });

    await test.step('uses NTLM auth inherited from the collection', async () => {
      await withNtlmServer({}, async (endpoint) => {
        setCollectionNtlmAuth(collectionDir);
        await sendTo({ name: 'inherited', url: `${endpoint.baseUrl}/api`, auth: 'inherit' }, 200);

        expect(endpoint.messageTypesSeen()).toEqual([null, 1, 3]);
        expect(endpoint.requests.map((request) => request.provedPassword)).toEqual([undefined, undefined, true]);
      });
    });

    await test.step('sends the body on every request of the handshake', async () => {
      await withNtlmServer({}, async (endpoint) => {
        await sendTo({
          name: 'body',
          url: `${endpoint.baseUrl}/api`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          jsonBody: '{"hello":"world"}'
        }, 200);

        expect(endpoint.messageTypesSeen()).toEqual([null, 1, 3]);
        expect(endpoint.requests.map((request) => JSON.parse(request.body))).toEqual([
          { hello: 'world' }, { hello: 'world' }, { hello: 'world' }
        ]);
      });
    });

    await test.step('negotiates again after a same host redirect and only sends X-retry with the finished message', async () => {
      await withNtlmServer({}, async (endpoint) => {
        const editor = await sendTo({ name: 'redirect', url: `${endpoint.baseUrl}/redirect?to=${endpoint.baseUrl}/landing` }, 200);
        await expect(buildCommonLocators(editor).response.previewContainer()).toContainText('/landing');

        expect(endpoint.messageTypesSeen()).toEqual([null, 1, 3, null, 1, 3]);
        const carryingRetry = endpoint.requests.filter((request) => request.headers['x-retry'] !== undefined);
        expect(carryingRetry.map((request) => request.type)).toEqual([3, 3]);
      });
    });

    await test.step('logs the NTLM handshake on the timeline', async () => {
      await withNtlmServer({}, async (endpoint) => {
        const editor = await sendTo({ name: 'timeline', url: `${endpoint.baseUrl}/api` }, 200);

        await selectResponsePaneTab(page, 'Timeline');
        const { timeline } = buildCommonLocators(editor);
        const entry = timeline.lastItem();
        await timeline.itemHeader(entry).click();
        await timeline.networkTab(entry).click();
        const logs = timeline.networkPanel(entry);
        // "TlRMTVNTUAAB" and "TlRMTVNTUAAD" are base64 for the NTLMSSP type 1 and type 3 messages.
        await expect(logs).toContainText('Authorization: NTLM TlRMTVNTUAAB');
        await expect(logs).toContainText('Authorization: NTLM TlRMTVNTUAAD');
        await expect(logs).toContainText('HTTP/1.1 200 OK');
      });
    });

    await test.step('negotiates and authenticates over a single TLS connection', async () => {
      await withNtlmServer({ tls: true }, async (endpoint) => {
        await sendTo({ name: 'https', url: `${endpoint.baseUrl}/api` }, 200);

        expect(endpoint.messageTypesSeen()).toEqual([null, 1, 3]);
        expect(endpoint.requests.map((request) => request.provedPassword)).toEqual([undefined, undefined, true]);
        expect(endpoint.connectionsUsed()).toBe(1);
      });
    });
  });
});
