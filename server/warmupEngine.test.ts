import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApiApp } from './app';
import { encryptSecret } from './crypto';
import { createDefaultSettings, InMemoryWarmupStore } from './firestoreStore';
import type { MailTransportAdapter, OutgoingEmailParams } from './mailService';
import { executeWarmupCycle, LOCK_DOC_ID, LOCK_TTL_MS } from './warmupEngine';
import type { GenAiCaller } from './contentService';
import type { MailboxPublic, MailboxTestResult, WarmupThread } from '../shared/types';

const TEST_ENC_KEY = crypto.randomBytes(32).toString('hex');
const TEST_CRON_SECRET = 'super-secure-cron-secret-token-2026';

function createMockMailAdapter(options: {
  simulateSpam?: boolean;
  simulateNoSpamFolder?: boolean;
  sentLog?: OutgoingEmailParams[];
  onCheckDelayMs?: number;
} = {}): MailTransportAdapter {
  let msgSeq = 1;
  const sentLog = options.sentLog ?? [];

  return {
    async testConnection(mailbox: MailboxPublic): Promise<MailboxTestResult> {
      return {
        ok: true,
        smtp: { ok: true, message: `SMTP OK (${mailbox.smtpHost})`, latencyMs: 12 },
        imap: {
          ok: true,
          message: options.simulateNoSpamFolder ? 'IMAP OK — brak folderu Spam' : 'IMAP OK — wykryto Spam',
          latencyMs: 15,
          spamFolder: options.simulateNoSpamFolder ? null : 'INBOX.Spam',
        },
        testedAt: new Date().toISOString(),
      };
    },
    async sendEmail(params: OutgoingEmailParams) {
      sentLog.push(params);
      return { messageId: `<msg-${msgSeq++}@mailpulse.test>` };
    },
    async checkHelperAndRescue({ pendingThreads, helper }) {
      if (options.onCheckDelayMs) {
        await new Promise((r) => setTimeout(r, options.onCheckDelayMs));
      }
      const warnings = options.simulateNoSpamFolder
        ? [`Skrzynka ${helper.email}: brak wykrytego folderu Spam — sprawdzono wyłącznie INBOX.`]
        : [];
      return {
        spamFolderDetected: options.simulateNoSpamFolder ? null : 'INBOX.Spam',
        warnings,
        matched: pendingThreads.map((t: WarmupThread) => ({
          thread: t,
          foundInSpam: Boolean(options.simulateSpam),
          rescuedMethod: options.simulateSpam ? 'copied_and_expunged' : undefined,
          parsedSnippet: t.bodySnippet ?? 'Treść wiadomości testowej',
        })),
      };
    },
  };
}

async function seedStoreWithMailboxes(store: InMemoryWarmupStore) {
  const now = '2026-05-10T08:00:00.000Z';
  await store.createOwnershipAtomic({
    ownerUid: 'owner-1',
    ownerEmail: 'owner@example.com',
    coOwnerEmails: ['coowner@example.com'],
    createdAt: now,
    updatedAt: now,
  });
  await store.saveSettings({
    ...createDefaultSettings('owner-1', ['owner@example.com', 'coowner@example.com'], new Date(now)),
    enabled: true,
    startDateKey: '2026-05-10',
    startDailyCount: 5,
    windowStartHour: 8,
    windowEndHour: 18,
    timezone: 'Europe/Warsaw',
  });

  await store.saveMailbox(
    {
      id: 'primary',
      ownerUid: 'owner-1',
      allowedEmails: ['owner@example.com', 'coowner@example.com'],
      role: 'primary',
      label: 'Główna',
      email: 'sender@company.test',
      smtpHost: 'smtp.company.test',
      smtpPort: 465,
      smtpSecurity: 'ssl_tls',
      imapHost: 'imap.company.test',
      imapPort: 993,
      imapSecurity: 'ssl_tls',
      active: true,
      hasPassword: true,
      createdAt: now,
      updatedAt: now,
    },
    encryptSecret('primary-secret-pass-99', TEST_ENC_KEY)
  );

  await store.saveMailbox(
    {
      id: 'helper-1',
      ownerUid: 'owner-1',
      allowedEmails: ['owner@example.com', 'coowner@example.com'],
      role: 'helper',
      label: 'Pomocnicza 1',
      email: 'helper1@partner.test',
      smtpHost: 'smtp.partner.test',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      imapHost: 'imap.partner.test',
      imapPort: 143,
      imapSecurity: 'starttls',
      active: true,
      hasPassword: true,
      createdAt: now,
      updatedAt: now,
    },
    encryptSecret('helper-secret-pass-88', TEST_ENC_KEY)
  );
}

test('warmup cycle sends email, rescues from Spam, replies with In-Reply-To & References, and logs fallback on 429', async () => {
  const store = new InMemoryWarmupStore();
  await seedStoreWithMailboxes(store);
  const sentLog: OutgoingEmailParams[] = [];
  const mailAdapter = createMockMailAdapter({ simulateSpam: true, sentLog });

  const rateLimitedAi: GenAiCaller = {
    async generateJson() {
      const err = new Error('429 RESOURCE_EXHAUSTED') as Error & { status?: number };
      err.status = 429;
      throw err;
    },
  };

  const result = await executeWarmupCycle({
    store,
    mailAdapter,
    source: 'cron',
    callerUid: 'owner-1',
    callerEmail: 'owner@example.com',
    encryptionKey: TEST_ENC_KEY,
    aiCaller: rateLimitedAi,
    now: new Date('2026-05-10T08:00:00Z'), // 10:00 Warsaw
    rng: () => 0.5,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.sent, true);
  assert.equal(result.usedFallback, true);
  assert.equal(result.rescuedFromSpamCount, 1);
  assert.equal(result.repliedCount, 1);
  assert.equal(sentLog.length, 2);

  // Verify reply headers In-Reply-To & References without artificial subject markers
  const outbound = sentLog[0];
  const reply = sentLog[1];
  assert.equal(outbound.subject.includes('[WARMUP'), false);
  assert.equal(reply.inReplyTo, '<msg-1@mailpulse.test>');
  assert.deepEqual(reply.references, ['<msg-1@mailpulse.test>']);
  assert.equal(reply.subject, `Re: ${outbound.subject}`);

  const stats = await store.getDailyStats('2026-05-10');
  assert.equal(stats?.sentCount, 1);
  assert.equal(stats?.repliedCount, 1);
  assert.equal(stats?.rescuedFromSpamCount, 1);
  assert.equal(stats?.fallbackCount, 2);

  // Lock must be released after completion
  assert.equal(await store.getLock(LOCK_DOC_ID), null);
});

test('concurrent double execution is blocked by transactional lock (2-min TTL) and recovers after TTL expiry', async () => {
  const store = new InMemoryWarmupStore();
  await seedStoreWithMailboxes(store);
  const nowMs = Date.parse('2026-05-10T08:00:00Z');

  // Pre-acquire an active lock simulating an in-flight tick
  const first = await store.acquireLock(LOCK_DOC_ID, 'owner-1', 'run-A', 'cron', LOCK_TTL_MS, nowMs);
  assert.equal(first.acquired, true);

  const mailAdapter = createMockMailAdapter();
  const secondResult = await executeWarmupCycle({
    store,
    mailAdapter,
    source: 'cron',
    callerUid: 'owner-1',
    callerEmail: 'owner@example.com',
    encryptionKey: TEST_ENC_KEY,
    aiCaller: null,
    now: new Date(nowMs + 30_000), // 30s later, still within 2-min TTL
  });

  assert.equal(secondResult.status, 'skipped_locked');
  assert.equal(secondResult.sent, false);

  // After TTL expires (> 120s), a new cycle safely takes over
  const afterExpiry = await executeWarmupCycle({
    store,
    mailAdapter,
    source: 'cron',
    callerUid: 'owner-1',
    callerEmail: 'owner@example.com',
    encryptionKey: TEST_ENC_KEY,
    aiCaller: null,
    now: new Date(nowMs + LOCK_TTL_MS + 5_000),
  });
  assert.equal(afterExpiry.status, 'completed');
  assert.equal(afterExpiry.sent, true);

  // Stale run-A trying to release lock after run-B acquired it must NOT affect run-B
  await store.acquireLock(LOCK_DOC_ID, 'owner-1', 'run-B', 'cron', LOCK_TTL_MS, nowMs + 200_000);
  await store.releaseLock(LOCK_DOC_ID, 'run-A');
  assert.equal((await store.getLock(LOCK_DOC_ID))?.lockedBy, 'run-B');
});

test('API routes enforce owner lock, cron secret protection, and zero password leakage', async () => {
  const store = new InMemoryWarmupStore();
  let currentEnv: NodeJS.ProcessEnv = {
    ENCRYPTION_KEY: TEST_ENC_KEY,
    CRON_SECRET: TEST_CRON_SECRET,
  };

  const tokenMap: Record<string, { uid: string; email: string }> = {
    'token-owner': { uid: 'uid-owner', email: 'owner@example.com' },
    'token-intruder': { uid: 'uid-intruder', email: 'stranger@example.com' },
    'token-coowner': { uid: 'uid-coowner', email: 'partner@example.com' },
  };

  const app = createApiApp({
    verifyToken: async (idToken) => {
      const entry = tokenMap[idToken];
      if (!entry) throw new Error('Invalid token');
      return { ...entry, emailVerified: true, idToken };
    },
    createUserStore: () => store,
    createCronStore: async () => store,
    mailAdapter: createMockMailAdapter({ simulateNoSpamFolder: true }),
    aiCaller: null,
    getEnv: () => currentEnv,
  });

  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. First Google account claims ownership
    const r1 = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-owner' },
    });
    assert.equal(r1.status, 200);
    const s1 = (await r1.json()) as { isPrimaryOwner: boolean; ownership: { ownerUid: string } };
    assert.equal(s1.isPrimaryOwner, true);
    assert.equal(s1.ownership.ownerUid, 'uid-owner');

    // 2. Different Google account is rejected with 403
    const rIntruder = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-intruder' },
    });
    assert.equal(rIntruder.status, 403);

    // 3. Owner adds co-owner email -> co-owner can now access
    const rSettings = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer token-owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ coOwnerEmails: ['partner@example.com'], enabled: true }),
    });
    assert.equal(rSettings.status, 200);

    const rCoOwner = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-coowner' },
    });
    assert.equal(rCoOwner.status, 200);

    // 4. Create mailbox with secret password -> password never appears in API JSON or logs
    const secretPass = 'UltraSensitiveMailboxPass!777';
    const rMb = await fetch(`${baseUrl}/api/mailboxes`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        role: 'primary',
        label: 'Main',
        email: 'main@domain.test',
        password: secretPass,
        smtpHost: 'smtp.domain.test',
        smtpPort: 465,
        smtpSecurity: 'ssl_tls',
        imapHost: 'imap.domain.test',
        imapPort: 993,
        imapSecurity: 'ssl_tls',
      }),
    });
    assert.equal(rMb.status, 201);
    const mbText = await rMb.text();
    assert.equal(mbText.includes(secretPass), false);
    assert.equal(mbText.includes('encryptedPassword'), false);
    assert.equal(mbText.includes('"hasPassword":true'), true);

    const rDash = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { Authorization: 'Bearer token-owner' },
    });
    assert.equal(rDash.status, 200);
    const dashText = await rDash.text();
    assert.equal(dashText.includes(secretPass), false);
    assert.equal(dashText.includes(TEST_ENC_KEY), false);
    assert.equal(dashText.includes(TEST_CRON_SECRET), false);

    // 5. Cron endpoint rejects missing/wrong secret with 401
    const rCronUnauth = await fetch(`${baseUrl}/api/cron/tick`, { method: 'POST' });
    assert.equal(rCronUnauth.status, 401);

    const rCronWrong = await fetch(`${baseUrl}/api/cron/tick`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(rCronWrong.status, 401);

    // 6. Cron endpoint accepts Bearer and x-cron-secret
    const rCronOk = await fetch(`${baseUrl}/api/cron/tick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` },
    });
    assert.equal(rCronOk.status, 200);

    const rCronHeader = await fetch(`${baseUrl}/api/cron/tick`, {
      method: 'POST',
      headers: { 'x-cron-secret': TEST_CRON_SECRET },
    });
    assert.equal(rCronHeader.status, 200);

    // 7. Unset CRON_SECRET returns 503; bad ENCRYPTION_KEY returns 400 on mailbox creation
    currentEnv = { ENCRYPTION_KEY: 'invalid-short', CRON_SECRET: '' };
    const rCronNoEnv = await fetch(`${baseUrl}/api/cron/tick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` },
    });
    assert.equal(rCronNoEnv.status, 503);

    const rBadKey = await fetch(`${baseUrl}/api/mailboxes`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        role: 'helper',
        label: 'Helper 2',
        email: 'h2@domain.test',
        password: 'abc',
        smtpHost: 'smtp.domain.test',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        imapHost: 'imap.domain.test',
        imapPort: 143,
        imapSecurity: 'starttls',
      }),
    });
    assert.equal(rBadKey.status, 400);
  } finally {
    server.close();
  }
});
