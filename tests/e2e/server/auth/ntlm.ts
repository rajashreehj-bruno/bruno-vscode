/**
 * NTLM test server.
 *
 * Authentication is bound to the connection, the way IIS does it, so a handshake split across
 * sockets fails here instead of passing quietly. Every request is recorded to make that reuse
 * observable, and `/redirect?to=<url>` takes its target from the request so no test configures it.
 *
 * Each spec starts its own instance on a free port, so the recorded requests belong to that test alone.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo, Socket } from 'net';
import { SERVER_CERT, SERVER_KEY, generateCerts } from '../../ssl/client-certificate/server/mtls-certs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const md4 = require('js-md4') as { create: () => { update: (data: Buffer) => void; buffer: () => ArrayBuffer } };

const NEGOTIATE_UNICODE = 1;
const NEGOTIATE_NTLM2_KEY = 1 << 19;
const NEGOTIATE_TARGET_INFO = 1 << 23;

const HEADER_SCHEME = 'NTLM ';
const SIGNATURE = 'NTLMSSP\0';
const MESSAGE_TYPE_OFFSET = SIGNATURE.length;
const CHALLENGE_MESSAGE_TYPE = 2;
const TARGET_NAME_FIELDS_OFFSET = 12;
const NEGOTIATE_FLAGS_OFFSET = 20;
const SERVER_CHALLENGE_OFFSET = 24;
const TARGET_INFO_FIELDS_OFFSET = 40;
const HEADER_SIZE = 48;
const TARGET_INFO_TERMINATOR_SIZE = 4;
const NT_RESPONSE_OFFSET = 20;
const DOMAIN_OFFSET = 28;
const USERNAME_OFFSET = 36;
const PROOF_SIZE = 16;

type NtlmSocket = Socket & { ntlmSocketId?: number; ntlmChallenge?: Buffer };

export interface NtlmRequestRecord {
  socketId: number | undefined;
  type: number | null;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
  provedPassword?: boolean;
}

export interface NtlmEndpoint {
  baseUrl: string;
  requests: NtlmRequestRecord[];
  messageTypesSeen: () => Array<number | null>;
  connectionsUsed: () => number;
  close: () => Promise<void>;
}

// A security buffer points at data after the header: its length, its max length (which senders set to the same), then where it starts.
const writeSecurityBuffer = (message: Buffer, offset: number, { length, start }: { length: number; start: number }) => {
  message.writeUInt16LE(length, offset);
  message.writeUInt16LE(length, offset + 2);
  message.writeUInt32LE(start, offset + 4);
};

const readSecurityBuffer = (message: Buffer, offset: number) => {
  const length = message.readUInt16LE(offset);
  const start = message.readUInt32LE(offset + 4);
  return message.subarray(start, start + length);
};

/**
 * Only the challenge is built here, since type 1 and type 3 come from the client under test. The
 * caller keeps the nonce with its connection because the client keys its proof by it, so a proof
 * answering one connection cannot be replayed onto another.
 */
const type2Message = (challenge: Buffer) => {
  const message = Buffer.alloc(HEADER_SIZE + TARGET_INFO_TERMINATOR_SIZE);

  message.write(SIGNATURE, 0, 'ascii');
  message.writeUInt32LE(CHALLENGE_MESSAGE_TYPE, MESSAGE_TYPE_OFFSET);
  writeSecurityBuffer(message, TARGET_NAME_FIELDS_OFFSET, { length: 0, start: HEADER_SIZE });
  message.writeUInt32LE(NEGOTIATE_UNICODE | NEGOTIATE_NTLM2_KEY | NEGOTIATE_TARGET_INFO, NEGOTIATE_FLAGS_OFFSET);
  challenge.copy(message, SERVER_CHALLENGE_OFFSET);
  writeSecurityBuffer(message, TARGET_INFO_FIELDS_OFFSET, { length: TARGET_INFO_TERMINATOR_SIZE, start: HEADER_SIZE });

  return `${HEADER_SCHEME}${message.toString('base64')}`;
};

const decodeHeader = (authorization: string | undefined) =>
  (authorization?.startsWith(HEADER_SCHEME) ? Buffer.from(authorization.slice(HEADER_SCHEME.length), 'base64') : null);

const messageType = (authorization: string | undefined): number | null => {
  const message = decodeHeader(authorization);

  if (!message || message.toString('ascii', 0, SIGNATURE.length) !== SIGNATURE) {
    return null;
  }

  return message.readUInt32LE(MESSAGE_TYPE_OFFSET);
};

const parseType3Message = (authorization: string) => {
  const message = decodeHeader(authorization)!;

  return {
    ntResponse: readSecurityBuffer(message, NT_RESPONSE_OFFSET),
    domain: readSecurityBuffer(message, DOMAIN_OFFSET).toString('ucs2'),
    username: readSecurityBuffer(message, USERNAME_OFFSET).toString('ucs2')
  };
};

const ntlmHashOf = (password: string) => {
  const hash = md4.create();
  hash.update(Buffer.from(password, 'ucs2'));
  return Buffer.from(hash.buffer());
};

/**
 * The proof is recomputed rather than trusted, so no test can pass against a server that accepts
 * any credentials. The arithmetic is the one in MS-NLMP 3.3.2 so an unmodified client verifies
 * here, with the password standing in for the hash a domain controller would hold instead.
 */
const provesPassword = (authorization: string, password: string, challenge: Buffer) => {
  const { ntResponse, domain, username } = parseType3Message(authorization);

  if (ntResponse.length <= PROOF_SIZE) {
    return false;
  }

  const proof = ntResponse.subarray(0, PROOF_SIZE);
  const blob = ntResponse.subarray(PROOF_SIZE);
  const ntlmv2Hash = crypto
    .createHmac('md5', ntlmHashOf(password))
    .update(Buffer.from(`${username.toUpperCase()}${domain}`, 'ucs2'))
    .digest();
  const expected = crypto
    .createHmac('md5', ntlmv2Hash)
    .update(Buffer.concat([challenge, blob]))
    .digest();

  return crypto.timingSafeEqual(proof, expected);
};

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });

const handleRequest = (password: string, requests: NtlmRequestRecord[]) =>
  async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const body = await readBody(req);
    const authorization = req.headers.authorization;
    const [pathname, query] = (req.url || '').split('?');
    const socket = req.socket as NtlmSocket;

    const record: NtlmRequestRecord = {
      socketId: socket.ntlmSocketId,
      type: messageType(authorization),
      url: req.url || '',
      body,
      headers: req.headers
    };
    requests.push(record);

    const challengeWith = (header: string) => {
      res.writeHead(401, { 'www-authenticate': header, 'content-length': 0 });
      res.end();
    };

    switch (record.type) {
      case 1: {
        const nonce = crypto.randomBytes(8);
        socket.ntlmChallenge = nonce;
        return challengeWith(type2Message(nonce));
      }
      case 3: {
        const nonce = socket.ntlmChallenge;
        record.provedPassword = Boolean(nonce) && provesPassword(authorization!, password, nonce!);

        if (!record.provedPassword) {
          return challengeWith('Negotiate, NTLM');
        }
        if (pathname === '/redirect') {
          res.writeHead(302, { 'location': new URLSearchParams(query).get('to') || '/', 'content-length': 0 });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ authenticated: true, url: pathname }));
      }
      default:
        return challengeWith('NTLM');
    }
  };

export const startNtlmServer = async ({ password = 'pass', host = '127.0.0.1', tls = false } = {}): Promise<NtlmEndpoint> => {
  const requests: NtlmRequestRecord[] = [];
  const sockets: Socket[] = [];
  const handler = handleRequest(password, requests);

  let listener: http.Server;
  if (tls) {
    generateCerts();
    listener = https.createServer({ key: fs.readFileSync(SERVER_KEY), cert: fs.readFileSync(SERVER_CERT) }, handler);
  } else {
    listener = http.createServer(handler);
  }

  let socketId = 0;
  // Over TLS the request's socket is the TLS socket, which only `secureConnection` hands out.
  listener.on(tls ? 'secureConnection' : 'connection', (socket: NtlmSocket) => {
    socket.ntlmSocketId = ++socketId;
    sockets.push(socket);
  });

  await new Promise<void>((resolve) => listener.listen(0, host, resolve));
  const { port } = listener.address() as AddressInfo;
  const urlHost = host.includes(':') ? `[${host}]` : host;

  return {
    baseUrl: `${tls ? 'https' : 'http'}://${urlHost}:${port}`,
    requests,
    messageTypesSeen: () => requests.map((request) => request.type),
    connectionsUsed: () => new Set(requests.map((request) => request.socketId)).size,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => listener.close(resolve));
    }
  };
};
