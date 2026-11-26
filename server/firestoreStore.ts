import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DailyStats,
  ExecutionLock,
  MailboxPublic,
  OwnershipDoc,
  RuntimeSecretsDoc,
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

  getRuntimeSecrets(): Promise<RuntimeSecretsDoc | null>;
  createRuntimeSecretsAtomic(doc: RuntimeSecretsDoc): Promise<{ created: boolean }>;
  updateRuntimeSecretsCron(cronSecret: string, updatedAt: string): Promise<RuntimeSecretsDoc>;

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
    hasCustomAiKey: false,
    encryptedGeminiApiKey: '',
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

export function resetFirebaseConfigCache(): void {
  cachedFirebaseConfig = null;
}

/**
 * Loads Firebase project & Firestore database ID.
 * Priority:
 * 1. Server environment variables (FIREBASE_PROJECT_ID / FIREBASE_DATABASE_ID) for standalone deployments.
 * 2. Bundled firebase-applet-config.json fallback.
 */
export function loadFirebaseAppletConfig(env: NodeJS.ProcessEnv = process.env): FirebaseAppletConfig {
  const envProjectId = (env.FIREBASE_PROJECT_ID ?? env.VITE_FIREBASE_PROJECT_ID ?? '').trim();
  if (envProjectId) {
    const envDbId = (env.FIREBASE_DATABASE_ID ?? env.VITE_FIREBASE_DATABASE_ID ?? '').trim();
    return {
      projectId: envProjectId,
      firestoreDatabaseId: envDbId || '(default)',
    };
  }

  if (cachedFirebaseConfig) return cachedFirebaseConfig;
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      'Brak konfiguracji Firebase: ustaw FIREBASE_PROJECT_ID w pliku .env (lub dodaj firebase-applet-config.json).'
    );
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  cachedFirebaseConfig = JSON.parse(raw) as FirebaseAppletConfig;
  return cachedFirebaseConfig;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedServiceAccountToken: { token: string; expiresAtMs: number } | null = null;

export function resetServiceAccountTokenCache(): void {
  cachedServiceAccountToken = null;
}

function parseServiceAccountFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceAccountKey | null {
  const inlineRaw = (env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (inlineRaw) {
    const jsonText = inlineRaw.startsWith('{')
      ? inlineRaw
      : Buffer.from(inlineRaw, 'base64').toString('utf8');
    const parsed = JSON.parse(jsonText) as Partial<ServiceAccountKey>;
    if (parsed.client_email && parsed.private_key) {
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key.replace(/\\n/g, '\n'),
        token_uri: parsed.token_uri,
      };
    }
  }

  const credPath = (env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (credPath && fs.existsSync(credPath)) {
    const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8')) as Partial<ServiceAccountKey>;
    if (parsed.client_email && parsed.private_key) {
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key.replace(/\\n/g, '\n'),
        token_uri: parsed.token_uri,
      };
    }
  }

  return null;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export async function fetchServiceAccountAccessToken(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const nowMs = Date.now();
  if (cachedServiceAccountToken && cachedServiceAccountToken.expiresAtMs - 60_000 > nowMs) {
    return cachedServiceAccountToken.token;
  }

  let sa: ServiceAccountKey | null = null;
  try {
    sa = parseServiceAccountFromEnv(env);
  } catch {
    return null;
  }
  if (!sa) return null;

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const tokenEndpoint = 'https://oauth2.googleapis.com/token';

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: tokenEndpoint,
      iat,
      exp,
    })
  );

  const signingInput = `${header}.${claimSet}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    const ttlSec = typeof data.expires_in === 'number' && data.expires_in > 120 ? data.expires_in : 3500;
    cachedServiceAccountToken = {
      token: data.access_token,
      expiresAtMs: nowMs + ttlSec * 1000,
    };
    return data.access_token;
  } catch {
    return null;
  }
}

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

export async function resolveServerFirestoreAccessToken(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const saToken = await fetchServiceAccountAccessToken(env);
  if (saToken) return saToken;
  return fetchMetadataAccessToken();
}

const WORKSPACE_PREFIX_REGEX = /^$|^users\/[a-zA-Z0-9_-]{1,128}$/;

export class FirestoreRestStore implements WarmupStore {
  private readonly projectId: string;
  private readonly databaseId: string;
  private readonly bearerToken: string;
  private readonly workspacePrefix: string;

  constructor(bearerToken: string, config?: FirebaseAppletConfig, workspacePrefix = '') {
    if (!WORKSPACE_PREFIX_REGEX.test(workspacePrefix)) {
      throw new Error('Nieprawidłowy prefiks przestrzeni roboczej Firestore.');
    }
    const cfg = config ?? loadFirebaseAppletConfig();
    this.projectId = cfg.projectId;
    this.databaseId = cfg.firestoreDatabaseId || '(default)';
    this.bearerToken = bearerToken;
    this.workspacePrefix = workspacePrefix;
  }

  private get documentsRoot(): string {
    return `projects/${this.projectId}/databases/${this.databaseId}/documents`;
  }

  private get dbRoot(): string {
    return this.workspacePrefix ? `${this.documentsRoot}/${this.workspacePrefix}` : this.documentsRoot;
  }

  private get baseUrl(): string {
    return `https://firestore.googleapis.com/v1/${this.dbRoot}`;
  }

  private get commitUrl(): string {
    return `https://firestore.googleapis.com/v1/${this.documentsRoot}:commit`;
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
    const resp = await fetch(this.commitUrl, {
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

  async getRuntimeSecrets(): Promise<RuntimeSecretsDoc | null> {
    const doc = await this.getDoc<RuntimeSecretsDoc>('runtime_secrets/keys');
    if (!doc) return null;
    const { __docId: _, ...rest } = doc;
    return rest;
  }

  async createRuntimeSecretsAtomic(doc: RuntimeSecretsDoc): Promise<{ created: boolean }> {
    const resp = await fetch(`${this.baseUrl}/runtime_secrets/keys?currentDocument.exists=false`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: encodeFields(doc as unknown as Record<string, unknown>),
      }),
    });

    if (resp.status === 409 || resp.status === 400) {
      return { created: false };
    }
    if (resp.status === 403 || resp.status === 401) {
      const txt = await resp.text();
      throw new FirestorePermissionError(resp.status, txt || 'Brak uprawnień do zapisu kluczy przestrzeni roboczej.');
    }
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Runtime secrets create failed: HTTP ${resp.status} ${txt.slice(0, 200)}`);
    }
    return { created: true };
  }

  async updateRuntimeSecretsCron(cronSecret: string, updatedAt: string): Promise<RuntimeSecretsDoc> {
    const current = await this.getRuntimeSecrets();
    if (!current) {
      throw new Error('Brak wygenerowanych kluczy przestrzeni roboczej.');
    }
    const updated: RuntimeSecretsDoc = {
      ...current,
      cronSecret,
      updatedAt,
    };
    await this.putDoc('runtime_secrets/keys', updated as unknown as Record<string, unknown>, true);
    return updated;
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
      encryptedGeminiApiKey: settings.encryptedGeminiApiKey ?? '',
      hasCustomAiKey: Boolean(settings.encryptedGeminiApiKey),
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

export class InMemoryWarmupStore implements WarmupStore {
  ownership: OwnershipDoc | null = null;
  runtimeSecrets: RuntimeSecretsDoc | null = null;
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

  async getRuntimeSecrets(): Promise<RuntimeSecretsDoc | null> {
    return this.runtimeSecrets ? { ...this.runtimeSecrets } : null;
  }

  async createRuntimeSecretsAtomic(doc: RuntimeSecretsDoc): Promise<{ created: boolean }> {
    if (this.runtimeSecrets) return { created: false };
    this.runtimeSecrets = { ...doc };
    return { created: true };
  }

  async updateRuntimeSecretsCron(cronSecret: string, updatedAt: string): Promise<RuntimeSecretsDoc> {
    if (!this.runtimeSecrets) throw new Error('Brak wygenerowanych kluczy przestrzeni roboczej.');
    this.runtimeSecrets = { ...this.runtimeSecrets, cronSecret, updatedAt };
    return { ...this.runtimeSecrets };
  }

  async getSettings(): Promise<WarmupSettings | null> {
    return this.settings ? { ...this.settings } : null;
  }

  async saveSettings(settings: WarmupSettings): Promise<void> {
    this.settings = { ...settings, hasCustomAiKey: Boolean(settings.encryptedGeminiApiKey) };
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
