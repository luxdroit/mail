import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreRestStore } from './firestoreStore';

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
