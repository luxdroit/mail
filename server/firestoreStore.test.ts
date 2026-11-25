import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchServiceAccountAccessToken,
  FirestoreRestStore,
  loadFirebaseAppletConfig,
  resetFirebaseConfigCache,
  resetServiceAccountTokenCache,
} from './firestoreStore';

interface MockFetchCall {
  url: string;
  method: string;
  body?: string;
}

describe('FirestoreRestStore lock concurrency (REST preconditions, no :beginTransaction)', () => {
  it('acquires a new lock using PATCH ?currentDocument.exists=false without calling :beginTransaction', async () => {
    const calls: MockFetchCall[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (method === 'GET' && url.endsWith('/locks/warmup_tick')) {
        return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), { status: 404 });
      }
      if (method === 'PATCH' && url.includes('/locks/warmup_tick?currentDocument.exists=false')) {
        return new Response(JSON.stringify({ name: 'projects/p/databases/d/documents/locks/warmup_tick' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    try {
      const store = new FirestoreRestStore('firebase-user-id-token', {
        projectId: 'test-proj',
        firestoreDatabaseId: 'test-db',
      });

      const res = await store.acquireLock('warmup_tick', 'uid-owner', 'run-1', 'manual', 120_000, 1_700_000_000_000);
      assert.equal(res.acquired, true);
      assert.equal(calls.some((c) => c.url.includes(':beginTransaction')), false);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[1].method, 'PATCH');
      assert.ok(calls[1].url.includes('currentDocument.exists=false'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects when an active unexpired lock exists without issuing any write', async () => {
    const calls: MockFetchCall[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (method === 'GET' && url.endsWith('/locks/warmup_tick')) {
        return new Response(
          JSON.stringify({
            name: 'projects/test-proj/databases/test-db/documents/locks/warmup_tick',
            updateTime: '2026-11-25T18:00:00.123456Z',
            fields: {
              ownerUid: { stringValue: 'uid-owner' },
              lockedBy: { stringValue: 'other-run' },
              source: { stringValue: 'cron' },
              acquiredAtMs: { integerValue: '1700000000000' },
              expiresAtMs: { integerValue: '1700000120000' },
            },
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    try {
      const store = new FirestoreRestStore('firebase-user-id-token', {
        projectId: 'test-proj',
        firestoreDatabaseId: 'test-db',
      });

      const res = await store.acquireLock('warmup_tick', 'uid-owner', 'run-2', 'manual', 120_000, 1_700_000_050_000);
      assert.equal(res.acquired, false);
      assert.equal(res.existingLock?.lockedBy, 'other-run');
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('overwrites an expired lock atomically with currentDocument.updateTime and handles 409 contention', async () => {
    const calls: MockFetchCall[] = [];
    const originalFetch = globalThis.fetch;
    let getCount = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (method === 'GET' && url.endsWith('/locks/warmup_tick')) {
        getCount += 1;
        if (getCount === 1) {
          // Expired lock
          return new Response(
            JSON.stringify({
              name: 'projects/test-proj/databases/test-db/documents/locks/warmup_tick',
              updateTime: '2026-11-25T17:00:00.000000Z',
              fields: {
                ownerUid: { stringValue: 'uid-owner' },
                lockedBy: { stringValue: 'stale-run' },
                source: { stringValue: 'manual' },
                acquiredAtMs: { integerValue: '1700000000000' },
                expiresAtMs: { integerValue: '1700000120000' },
              },
            }),
            { status: 200 }
          );
        }
        // On retry, another concurrent runner won the lock
        return new Response(
          JSON.stringify({
            name: 'projects/test-proj/databases/test-db/documents/locks/warmup_tick',
            updateTime: '2026-11-25T18:10:00.000000Z',
            fields: {
              ownerUid: { stringValue: 'uid-owner' },
              lockedBy: { stringValue: 'winner-run' },
              source: { stringValue: 'cron' },
              acquiredAtMs: { integerValue: '1700000500000' },
              expiresAtMs: { integerValue: '1700000620000' },
            },
          }),
          { status: 200 }
        );
      }

      if (method === 'PATCH' && url.includes('currentDocument.updateTime=2026-11-25T17%3A00%3A00.000000Z')) {
        return new Response(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION' } }), { status: 400 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    try {
      const store = new FirestoreRestStore('firebase-user-id-token', {
        projectId: 'test-proj',
        firestoreDatabaseId: 'test-db',
      });

      const res = await store.acquireLock('warmup_tick', 'uid-owner', 'loser-run', 'manual', 120_000, 1_700_000_510_000);
      assert.equal(res.acquired, false);
      assert.equal(res.existingLock?.lockedBy, 'winner-run');
      assert.equal(calls.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('releases only its own lock with DELETE ?currentDocument.updateTime', async () => {
    const calls: MockFetchCall[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (method === 'GET' && url.endsWith('/locks/warmup_tick')) {
        return new Response(
          JSON.stringify({
            name: 'projects/test-proj/databases/test-db/documents/locks/warmup_tick',
            updateTime: '2026-11-25T18:05:00.500000Z',
            fields: {
              ownerUid: { stringValue: 'uid-owner' },
              lockedBy: { stringValue: 'my-run' },
              source: { stringValue: 'manual' },
              acquiredAtMs: { integerValue: '1700000000000' },
              expiresAtMs: { integerValue: '1700000120000' },
            },
          }),
          { status: 200 }
        );
      }

      if (method === 'DELETE' && url.includes('currentDocument.updateTime=2026-11-25T18%3A05%3A00.500000Z')) {
        return new Response('', { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    try {
      const store = new FirestoreRestStore('firebase-user-id-token', {
        projectId: 'test-proj',
        firestoreDatabaseId: 'test-db',
      });

      await store.releaseLock('warmup_tick', 'my-run');
      assert.equal(calls.length, 2);
      assert.equal(calls[1].method, 'DELETE');
      assert.ok(calls[1].url.includes('currentDocument.updateTime=2026-11-25T18%3A05%3A00.500000Z'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Standalone Firebase config and Service Account OAuth2 token resolution', () => {
  it('prioritizes FIREBASE_PROJECT_ID and FIREBASE_DATABASE_ID env vars over bundled json', () => {
    resetFirebaseConfigCache();
    const cfg = loadFirebaseAppletConfig({
      FIREBASE_PROJECT_ID: 'my-standalone-project',
      FIREBASE_DATABASE_ID: 'custom-db',
    });
    assert.equal(cfg.projectId, 'my-standalone-project');
    assert.equal(cfg.firestoreDatabaseId, 'custom-db');

    const cfgDefaultDb = loadFirebaseAppletConfig({
      FIREBASE_PROJECT_ID: 'another-project',
    });
    assert.equal(cfgDefaultDb.projectId, 'another-project');
    assert.equal(cfgDefaultDb.firestoreDatabaseId, '(default)');
  });

  it('signs an RS256 JWT assertion from FIREBASE_SERVICE_ACCOUNT_JSON and caches the OAuth2 access token', async () => {
    resetServiceAccountTokenCache();
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const saJson = JSON.stringify({
      client_email: 'warmup-cron@my-standalone-project.iam.gserviceaccount.com',
      private_key: privateKey,
    });

    const originalFetch = globalThis.fetch;
    let tokenCalls = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(init?.method, 'POST');
      const bodyStr = String(init?.body ?? '');
      assert.ok(bodyStr.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer'));
      assert.ok(bodyStr.includes('assertion='));
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: 'ya29.test-standalone-token', expires_in: 3600 }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      const token1 = await fetchServiceAccountAccessToken({
        FIREBASE_SERVICE_ACCOUNT_JSON: Buffer.from(saJson, 'utf8').toString('base64'),
      });
      const token2 = await fetchServiceAccountAccessToken({
        FIREBASE_SERVICE_ACCOUNT_JSON: saJson,
      });
      assert.equal(token1, 'ya29.test-standalone-token');
      assert.equal(token2, 'ya29.test-standalone-token');
      assert.equal(tokenCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      resetServiceAccountTokenCache();
    }
  });
});

describe('FirestoreRestStore personal workspace prefix and runtime_secrets paths', () => {
  it('routes subcollection documents under /users/{uid}/... while keeping :commit on /documents:commit', async () => {
    const calls: MockFetchCall[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      const store = new FirestoreRestStore(
        'user-id-token',
        { projectId: 'test-proj', firestoreDatabaseId: 'test-db' },
        'users/user_abc123'
      );

      await store.createOwnershipAtomic({
        ownerUid: 'user_abc123',
        ownerEmail: 'user@example.com',
        coOwnerEmails: [],
        createdAt: '2026-11-25T10:00:00.000Z',
        updatedAt: '2026-11-25T10:00:00.000Z',
      });

      await store.createRuntimeSecretsAtomic({
        ownerUid: 'user_abc123',
        encryptionKey: 'a'.repeat(64),
        cronSecret: 'b'.repeat(48),
        createdAt: '2026-11-25T10:00:00.000Z',
        updatedAt: '2026-11-25T10:00:00.000Z',
      });

      assert.equal(
        calls[0].url,
        'https://firestore.googleapis.com/v1/projects/test-proj/databases/test-db/documents:commit'
      );
      assert.ok(
        calls[0].body?.includes(
          'projects/test-proj/databases/test-db/documents/users/user_abc123/system/ownership'
        )
      );
      assert.equal(
        calls[1].url,
        'https://firestore.googleapis.com/v1/projects/test-proj/databases/test-db/documents/users/user_abc123/runtime_secrets/keys?currentDocument.exists=false'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

