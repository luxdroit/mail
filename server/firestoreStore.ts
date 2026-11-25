import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DailyStats,
  ExecutionLock,
  MailboxPublic,
  OwnershipDoc,
  WarmupLog,
  WarmupSettings,
  WarmupThread,
} from '../shared/types';
import { DEFAULT_AI_MODEL, DEFAULT_TIMEZONE } from '../shared/types';
import { getZonedParts } from './schedule';

export class FirestorePermissionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FirestorePermissionError';
    this.status = status;
  }
}

export interface LockAcquireResult {
  acquired: boolean;
  existingLock?: ExecutionLock;
}

export interface WarmupStore {
  getOwnership(): Promise<OwnershipDoc | null>;
  createOwnershipAtomic(doc: OwnershipDoc): Promise<{ created: boolean }>;
  updateOwnershipCoOwners(coOwnerEmails: string[], updatedAt: string): Promise<void>;

  getSettings(): Promise<WarmupSettings | null>;
  saveSettings(settings: WarmupSettings): Promise<void>;

  listMailboxes(ownerUid: string, callerUid: string, callerEmail: string): Promise<MailboxPublic[]>;
  getMailbox(id: string): Promise<MailboxPublic | null>;
  saveMailbox(mailbox: MailboxPublic, encryptedPassword?: string): Promise<void>;
  deleteMailbox(id: string): Promise<void>;
  getMailboxEncryptedPassword(id: string): Promise<string | null>;

  getThread(id: string): Promise<WarmupThread | null>;
  saveThread(thread: WarmupThread): Promise<void>;
  listPendingThreadsForHelper(
    ownerUid: string,
    callerUid: string,
    callerEmail: string,
    helperMailboxId: string
  ): Promise<WarmupThread[]>;

  getDailyStats(dateKey: string): Promise<DailyStats | null>;
  saveDailyStats(stats: DailyStats): Promise<void>;

  appendLog(log: Omit<WarmupLog, 'id'> & { id?: string }): Promise<WarmupLog>;
  listRecentLogs(ownerUid: string, callerUid: string, callerEmail: string, limit?: number): Promise<WarmupLog[]>;

  getLock(lockId: string): Promise<ExecutionLock | null>;
  acquireLock(
    lockId: string,
    ownerUid: string,
    runId: string,
    source: 'cron' | 'manual',
    ttlMs: number,
    nowMs: number
  ): Promise<LockAcquireResult>;
  releaseLock(lockId: string, runId: string): Promise<void>;
}

export function createDefaultSettings(ownerUid: string, allowedEmails: string[], now: Date = new Date()): WarmupSettings {
  const zoned = getZonedParts(now, DEFAULT_TIMEZONE);
  return {
    ownerUid,
    allowedEmails,
    enabled: false,
    startDateKey: zoned.dateKey,
    startDailyCount: 3,
    dailyIncrement: 2,
    maxDailyCap: 40,
    minDelayMinutes: 15,
    maxDelayMinutes: 45,
    windowStartHour: 8,
    windowEndHour: 18,
    timezone: DEFAULT_TIMEZONE,
    messageFormat: 'plain',
    aiModel: DEFAULT_AI_MODEL,
    lastSentAt: '',
    nextAllowedSendAt: '',
    lastHelperIndex: 0,
    updatedAt: now.toISOString(),
  };
}

// --- Firestore REST API Value Codec ---

type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

function encodeValue(val: unknown): FsValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => encodeValue(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FsValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = encodeValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function encodeFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      fields[k] = encodeValue(v);
    }
  }
  return fields;
}

function decodeValue(val: FsValue | undefined): unknown {
  if (!val) return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    return (val.arrayValue.values ?? []).map((item) => decodeValue(item));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields ?? {})) {
      out[k] = decodeValue(v);
    }
    return out;
  }
  return undefined;
}

function decodeDocument<T>(doc: { name?: string; fields?: Record<string, FsValue> }): T & { __docId: string } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    out[k] = decodeValue(v);
  }
  const segments = (doc.name ?? '').split('/');
  const docId = segments[segments.length - 1] ?? '';
  return { ...(out as T), __docId: docId };
}

export interface FirebaseAppletConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

let cachedFirebaseConfig: FirebaseAppletConfig | null = null;

export function loadFirebaseAppletConfig(): FirebaseAppletConfig {
  if (cachedFirebaseConfig) return cachedFirebaseConfig;
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  cachedFirebaseConfig = JSON.parse(raw) as FirebaseAppletConfig;
  return cachedFirebaseConfig;
}

/**
 * Obtains a Google Cloud Access Token from the Cloud Run / GCE Metadata server
 * for unattended server-to-Firestore calls (used exclusively by POST /api/cron/tick on user-owned projects).
 */
export async function fetchMetadataAccessToken(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const resp = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

export class FirestoreRestStore implements WarmupStore {
  private readonly projectId: string;
  private readonly databaseId: string;
  private readonly bearerToken: string;

  constructor(bearerToken: string, config?: FirebaseAppletConfig) {
    const cfg = config ?? loadFirebaseAppletConfig();
    this.projectId = cfg.projectId;
    this.databaseId = cfg.firestoreDatabaseId || '(default)';
    this.bearerToken = bearerToken;
  }

  private get dbRoot(): string {
    return `projects/${this.projectId}/databases/${this.databaseId}/documents`;
  }

  private get baseUrl(): string {
    return `https://firestore.googleapis.com/v1/${this.dbRoot}`;
  }

  private docName(docPath: string): string {
    return `${this.dbRoot}/${docPath}`;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<{ status: number; data: T | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    const resp = await fetch(url, { ...init, headers });
    if (resp.status === 404) {
      return { status: 404, data: null };
    }
    if (resp.status === 403 || resp.status === 401) {
      const text = await resp.text();
      throw new FirestorePermissionError(resp.status, text || 'Brak uprawnień Firestore.');
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Firestore HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const text = await resp.text();
    if (!text) return { status: resp.status, data: null };
    return { status: resp.status, data: JSON.parse(text) as T };
  }

  private async getDoc<T>(docPath: string): Promise<(T & { __docId: string }) | null> {
    const { status, data } = await this.request<{ name: string; fields?: Record<string, FsValue> }>(
      `${this.baseUrl}/${docPath}`
    );
    if (status === 404 || !data) return null;
    return decodeDocument<T>(data);
  }

  private async putDoc(docPath: string, payload: Record<string, unknown>, existsPrecondition?: boolean): Promise<void> {
    const query =
      existsPrecondition === undefined ? '' : `?currentDocument.exists=${existsPrecondition ? 'true' : 'false'}`;
    await this.request(`${this.baseUrl}/${docPath}${query}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: encodeFields(payload) }),
    });
  }

  private async deleteDoc(docPath: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/${docPath}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });
    if (resp.status === 404) return;
    if (resp.status === 403 || resp.status === 401) {
      throw new FirestorePermissionError(resp.status, 'Brak uprawnień do usunięcia dokumentu.');
    }
    if (!resp.ok) {
      throw new Error(`Firestore DELETE HTTP ${resp.status}`);
    }
  }

  private async queryCollection<T>(
    collectionId: string,
    ownerUid: string,
    callerUid: string,
    callerEmail: string,
    extraFilter?: { field: string; value: string }
  ): Promise<Array<T & { __docId: string }>> {
    const ownershipFilter =
      callerUid === ownerUid || !callerEmail
        ? {
            fieldFilter: {
              field: { fieldPath: 'ownerUid' },
              op: 'EQUAL',
              value: { stringValue: ownerUid },
            },
          }
        : {
            fieldFilter: {
              field: { fieldPath: 'allowedEmails' },
              op: 'ARRAY_CONTAINS',
              value: { stringValue: callerEmail },
            },
          };

    const where = extraFilter
      ? {
          compositeFilter: {
            op: 'AND',
            filters: [
              ownershipFilter,
              {
                fieldFilter: {
                  field: { fieldPath: extraFilter.field },
                  op: 'EQUAL',
                  value: { stringValue: extraFilter.value },
                },
              },
            ],
          },
        }
      : ownershipFilter;

    const { data } = await this.request<Array<{ document?: { name: string; fields?: Record<string, FsValue> } }>>(
      `${this.baseUrl}:runQuery`,
      {
        method: 'POST',
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId }],
            where,
          },
        }),
      }
    );

    if (!Array.isArray(data)) return [];
    return data
      .filter((row) => Boolean(row.document))
      .map((row) => decodeDocument<T>(row.document!));
  }

  async getOwnership(): Promise<OwnershipDoc | null> {
    const doc = await this.getDoc<OwnershipDoc>('system/ownership');
    if (!doc) return null;
    const { __docId: _, ...rest } = doc;
    return rest;
  }

  async createOwnershipAtomic(ownership: OwnershipDoc): Promise<{ created: boolean }> {
    const resp = await fetch(`${this.baseUrl}:commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        writes: [
          {
            currentDocument: { exists: false },
            update: {
              name: this.docName('system/ownership'),
              fields: encodeFields(ownership as unknown as Record<string, unknown>),
            },
          },
        ],
      }),
    });

    if (resp.status === 409 || resp.status === 400 || resp.status === 403) {
      return { created: false };
    }
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Ownership create failed: HTTP ${resp.status} ${txt.slice(0, 200)}`);
    }
    return { created: true };
  }

  async updateOwnershipCoOwners(coOwnerEmails: string[], updatedAt: string): Promise<void> {
    const current = await this.getOwnership();
    if (!current) throw new Error('Brak rekordu właściciela.');
    await this.putDoc(
      'system/ownership',
      {
        ...current,
        coOwnerEmails,
        updatedAt,
      },
      true
    );
  }

  async getSettings(): Promise<WarmupSettings | null> {
    const doc = await this.getDoc<WarmupSettings>('settings/warmup');
    if (!doc) return null;
    const { __docId: _, ...rest } = doc;
    return rest;
  }

  async saveSettings(settings: WarmupSettings): Promise<void> {
    await this.putDoc('settings/warmup', {
      ...settings,
      lastSentAt: settings.lastSentAt ?? '',
      nextAllowedSendAt: settings.nextAllowedSendAt ?? '',
    });
  }

  async listMailboxes(ownerUid: string, callerUid: string, callerEmail: string): Promise<MailboxPublic[]> {
    const rows = await this.queryCollection<Omit<MailboxPublic, 'id'>>('mailboxes', ownerUid, callerUid, callerEmail);
    return rows
      .map(({ __docId, ...rest }) => ({ ...rest, id: __docId }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getMailbox(id: string): Promise<MailboxPublic | null> {
    const doc = await this.getDoc<Omit<MailboxPublic, 'id'>>(`mailboxes/${id}`);
    if (!doc) return null;
    const { __docId, ...rest } = doc;
    return { ...rest, id: __docId };
  }

  async saveMailbox(mailbox: MailboxPublic, encryptedPassword?: string): Promise<void> {
    const { id, ...fields } = mailbox;
    await this.putDoc(`mailboxes/${id}`, {
      ...fields,
      lastTestedAt: fields.lastTestedAt ?? '',
      lastTestStatus: fields.lastTestStatus ?? 'none',
      lastTestMessage: fields.lastTestMessage ?? '',
      lastCheckedAt: fields.lastCheckedAt ?? '',
    });
    if (encryptedPassword) {
      await this.putDoc(`mailbox_secrets/${id}`, {
        ownerUid: mailbox.ownerUid,
        encryptedPassword,
        updatedAt: mailbox.updatedAt,
      });
    }
  }

  async deleteMailbox(id: string): Promise<void> {
    await this.deleteDoc(`mailboxes/${id}`);
    await this.deleteDoc(`mailbox_secrets/${id}`);
  }

  async getMailboxEncryptedPassword(id: string): Promise<string | null> {
    const doc = await this.getDoc<{ encryptedPassword: string }>(`mailbox_secrets/${id}`);
    return doc?.encryptedPassword ?? null;
  }

  async getThread(id: string): Promise<WarmupThread | null> {
    const doc = await this.getDoc<Omit<WarmupThread, 'id'>>(`threads/${id}`);
    if (!doc) return null;
    const { __docId, ...rest } = doc;
    return { ...rest, id: __docId };
  }

  async saveThread(thread: WarmupThread): Promise<void> {
    const { id, ...fields } = thread;
    await this.putDoc(`threads/${id}`, {
      ...fields,
      bodySnippet: fields.bodySnippet ?? '',
      repliedAt: fields.repliedAt ?? '',
      replyMessageId: fields.replyMessageId ?? '',
    });
  }

  async listPendingThreadsForHelper(
    ownerUid: string,
    callerUid: string,
    callerEmail: string,
    helperMailboxId: string
  ): Promise<WarmupThread[]> {
    const rows = await this.queryCollection<Omit<WarmupThread, 'id'>>('threads', ownerUid, callerUid, callerEmail);
    return rows
      .map(({ __docId, ...rest }) => ({ ...rest, id: __docId }))
      .filter((t) => t.helperMailboxId === helperMailboxId && t.status === 'sent')
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  async getDailyStats(dateKey: string): Promise<DailyStats | null> {
    const doc = await this.getDoc<DailyStats>(`daily_stats/${dateKey}`);
    if (!doc) return null;
    const { __docId: _, ...rest } = doc;
    return rest;
  }

  async saveDailyStats(stats: DailyStats): Promise<void> {
    await this.putDoc(`daily_stats/${stats.dateKey}`, stats as unknown as Record<string, unknown>);
  }

  async appendLog(log: Omit<WarmupLog, 'id'> & { id?: string }): Promise<WarmupLog> {
    const id = log.id ?? `log_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const record: WarmupLog = { ...log, id };
    const { id: _, ...fields } = record;
    await this.putDoc(`logs/${id}`, fields as unknown as Record<string, unknown>);
    return record;
  }

  async listRecentLogs(
    ownerUid: string,
    callerUid: string,
    callerEmail: string,
    limit = 60
  ): Promise<WarmupLog[]> {
    const rows = await this.queryCollection<Omit<WarmupLog, 'id'>>('logs', ownerUid, callerUid, callerEmail);
    return rows
      .map(({ __docId, ...rest }) => ({ ...rest, id: __docId }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private async getDocWithMeta<T>(
    docPath: string
  ): Promise<{ data: T & { __docId: string }; updateTime: string } | null> {
    const { status, data } = await this.request<{
      name: string;
      fields?: Record<string, FsValue>;
      updateTime?: string;
    }>(`${this.baseUrl}/${docPath}`);
    if (status === 404 || !data) return null;
    return {
      data: decodeDocument<T>(data),
      updateTime: data.updateTime ?? '',
    };
  }

  async getLock(lockId: string): Promise<ExecutionLock | null> {
    const doc = await this.getDoc<ExecutionLock>(`locks/${lockId}`);
    if (!doc) return null;
    const { __docId: _, ...rest } = doc;
    return rest;
  }

  async acquireLock(
    lockId: string,
    ownerUid: string,
    runId: string,
    source: 'cron' | 'manual',
    ttlMs: number,
    nowMs: number
  ): Promise<LockAcquireResult> {
    const docPath = `locks/${lockId}`;
    const safeNowMs = Math.trunc(nowMs);
    const safeExpiresAtMs = Math.trunc(nowMs + ttlMs);

    // Atomic optimistic concurrency (Compare-And-Swap) using Firestore REST
    // currentDocument preconditions (exists=false / updateTime). Works with both
    // Firebase Auth user ID tokens (manual UI runs) and Cloud Run IAM tokens (cron).
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.getDocWithMeta<ExecutionLock>(docPath);

      if (existing) {
        const { __docId: _, ...existingLock } = existing.data;
        if (existingLock.expiresAtMs > safeNowMs) {
          return { acquired: false, existingLock };
        }
      }

      const nextLock: ExecutionLock = {
        ownerUid,
        lockedBy: runId,
        source,
        acquiredAtMs: safeNowMs,
        expiresAtMs: safeExpiresAtMs,
      };

      const query = existing
        ? existing.updateTime
          ? `?currentDocument.updateTime=${encodeURIComponent(existing.updateTime)}`
          : '?currentDocument.exists=true'
        : '?currentDocument.exists=false';

      const resp = await fetch(`${this.baseUrl}/${docPath}${query}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: encodeFields(nextLock as unknown as Record<string, unknown>),
        }),
      });

      if (resp.ok) {
        return { acquired: true };
      }

      const txt = await resp.text();
      if (
        resp.status === 409 ||
        (resp.status === 400 && (txt.includes('FAILED_PRECONDITION') || txt.includes('ALREADY_EXISTS')))
      ) {
        // Another concurrent caller updated or created the lock first — retry to observe active lock
        continue;
      }

      if (resp.status === 403 || resp.status === 401) {
        throw new FirestorePermissionError(resp.status, txt || 'Brak uprawnień Firestore przy zakładaniu locka.');
      }

      throw new Error(`Lock acquire HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }

    const latest = await this.getLock(lockId);
    return { acquired: false, existingLock: latest ?? undefined };
  }

  async releaseLock(lockId: string, runId: string): Promise<void> {
    const docPath = `locks/${lockId}`;
    try {
      const existing = await this.getDocWithMeta<ExecutionLock>(docPath);
      if (!existing || existing.data.lockedBy !== runId) {
        return;
      }

      const query = existing.updateTime
        ? `?currentDocument.updateTime=${encodeURIComponent(existing.updateTime)}`
        : '';

      await fetch(`${this.baseUrl}/${docPath}${query}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
        },
      });
    } catch {
      // Best-effort release; TTL guarantees recovery
    }
  }
}

/**
 * Deterministic in-memory store with atomic lock semantics used for unit & integration tests.
 */
export class InMemoryWarmupStore implements WarmupStore {
  ownership: OwnershipDoc | null = null;
  settings: WarmupSettings | null = null;
  mailboxes = new Map<string, MailboxPublic>();
  secrets = new Map<string, string>();
  threads = new Map<string, WarmupThread>();
  dailyStats = new Map<string, DailyStats>();
  logs: WarmupLog[] = [];
  locks = new Map<string, ExecutionLock>();

  async getOwnership(): Promise<OwnershipDoc | null> {
    return this.ownership ? { ...this.ownership, coOwnerEmails: [...this.ownership.coOwnerEmails] } : null;
  }

  async createOwnershipAtomic(doc: OwnershipDoc): Promise<{ created: boolean }> {
    if (this.ownership) return { created: false };
    this.ownership = { ...doc, coOwnerEmails: [...doc.coOwnerEmails] };
    return { created: true };
  }

  async updateOwnershipCoOwners(coOwnerEmails: string[], updatedAt: string): Promise<void> {
    if (!this.ownership) throw new Error('Brak właściciela.');
    this.ownership = { ...this.ownership, coOwnerEmails: [...coOwnerEmails], updatedAt };
  }

  async getSettings(): Promise<WarmupSettings | null> {
    return this.settings ? { ...this.settings } : null;
  }

  async saveSettings(settings: WarmupSettings): Promise<void> {
    this.settings = { ...settings };
  }

  async listMailboxes(): Promise<MailboxPublic[]> {
    return Array.from(this.mailboxes.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getMailbox(id: string): Promise<MailboxPublic | null> {
    const found = this.mailboxes.get(id);
    return found ? { ...found } : null;
  }

  async saveMailbox(mailbox: MailboxPublic, encryptedPassword?: string): Promise<void> {
    this.mailboxes.set(mailbox.id, { ...mailbox });
    if (encryptedPassword) {
      this.secrets.set(mailbox.id, encryptedPassword);
    }
  }

  async deleteMailbox(id: string): Promise<void> {
    this.mailboxes.delete(id);
    this.secrets.delete(id);
  }

  async getMailboxEncryptedPassword(id: string): Promise<string | null> {
    return this.secrets.get(id) ?? null;
  }

  async getThread(id: string): Promise<WarmupThread | null> {
    const found = this.threads.get(id);
    return found ? { ...found } : null;
  }

  async saveThread(thread: WarmupThread): Promise<void> {
    this.threads.set(thread.id, { ...thread });
  }

  async listPendingThreadsForHelper(
    _ownerUid: string,
    _callerUid: string,
    _callerEmail: string,
    helperMailboxId: string
  ): Promise<WarmupThread[]> {
    return Array.from(this.threads.values())
      .filter((t) => t.helperMailboxId === helperMailboxId && t.status === 'sent')
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  async getDailyStats(dateKey: string): Promise<DailyStats | null> {
    const found = this.dailyStats.get(dateKey);
    return found ? { ...found } : null;
  }

  async saveDailyStats(stats: DailyStats): Promise<void> {
    this.dailyStats.set(stats.dateKey, { ...stats });
  }

  async appendLog(log: Omit<WarmupLog, 'id'> & { id?: string }): Promise<WarmupLog> {
    const record: WarmupLog = {
      ...log,
      id: log.id ?? `log_${Date.now()}_${this.logs.length + 1}`,
    };
    this.logs.unshift(record);
    return record;
  }

  async listRecentLogs(_ownerUid: string, _callerUid: string, _callerEmail: string, limit = 60): Promise<WarmupLog[]> {
    return this.logs.slice(0, limit);
  }

  async getLock(lockId: string): Promise<ExecutionLock | null> {
    const found = this.locks.get(lockId);
    return found ? { ...found } : null;
  }

  async acquireLock(
    lockId: string,
    ownerUid: string,
    runId: string,
    source: 'cron' | 'manual',
    ttlMs: number,
    nowMs: number
  ): Promise<LockAcquireResult> {
    const current = this.locks.get(lockId);
    if (current && current.expiresAtMs > nowMs) {
      return { acquired: false, existingLock: { ...current } };
    }
    this.locks.set(lockId, {
      ownerUid,
      lockedBy: runId,
      source,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    });
    return { acquired: true };
  }

  async releaseLock(lockId: string, runId: string): Promise<void> {
    const current = this.locks.get(lockId);
    if (current && current.lockedBy === runId) {
      this.locks.delete(lockId);
    }
  }
}
