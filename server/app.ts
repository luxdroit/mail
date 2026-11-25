import crypto from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type {
  DashboardPayload,
  DailyStats,
  MailboxInput,
  MailboxPublic,
  MessageFormat,
  OwnershipDoc,
  RuntimeSecretsDoc,
  SecretsStatus,
  SecurityMode,
  SessionResponse,
  WarmupSettings,
} from '../shared/types';
import {
  createFirebaseTokenVerifier,
  extractBearerToken,
  verifyCronAuthorization,
  type TokenVerifier,
  type VerifiedUser,
} from './auth';
import {
  decryptSecret,
  EncryptionKeyError,
  encryptSecret,
  sanitizeForLogs,
  validateEncryptionKeyStatus,
} from './crypto';
import { testGeminiConnection, type GenAiCaller } from './contentService';
import {
  createDefaultSettings,
  FirestorePermissionError,
  FirestoreRestStore,
  resolveServerFirestoreAccessToken,
  type WarmupStore,
} from './firestoreStore';
import { RealMailTransportAdapter, type MailTransportAdapter } from './mailService';
import { computeDailyTarget, getZonedParts, isValidTimezone, isWithinSendingWindow } from './schedule';
import { executeWarmupCycle, LOCK_DOC_ID } from './warmupEngine';

export interface ApiAppDependencies {
  verifyToken?: TokenVerifier;
  createUserStore?: (idToken: string, workspacePrefix?: string) => WarmupStore;
  createCronStore?: (workspacePrefix?: string) => Promise<WarmupStore | null>;
  mailAdapter?: MailTransportAdapter;
  aiCaller?: GenAiCaller | null;
  getEnv?: () => NodeJS.ProcessEnv;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_REGEX = /^[a-zA-Z0-9.-]{1,253}$/;
const WORKSPACE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  'metadata.google.internal',
]);

function isBlockedHost(host: string): boolean {
  const lower = host.trim().toLowerCase();
  if (BLOCKED_HOSTS.has(lower)) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(lower)) {
    return true;
  }
  return false;
}

function validateMailboxInput(body: unknown, isCreate: boolean): { ok: true; data: MailboxInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Nieprawidłowe dane formularza skrzynki.' };
  }
  const b = body as Record<string, unknown>;
  const role = b.role === 'primary' || b.role === 'helper' ? b.role : null;
  if (!role) return { ok: false, error: 'Nieprawidłowa rola skrzynki (primary lub helper).' };

  const label = typeof b.label === 'string' ? b.label.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const smtpHost = typeof b.smtpHost === 'string' ? b.smtpHost.trim() : '';
  const imapHost = typeof b.imapHost === 'string' ? b.imapHost.trim() : '';
  const smtpPort = Number(b.smtpPort);
  const imapPort = Number(b.imapPort);
  const smtpSecurity: SecurityMode | null =
    b.smtpSecurity === 'ssl_tls' || b.smtpSecurity === 'starttls' ? b.smtpSecurity : null;
  const imapSecurity: SecurityMode | null =
    b.imapSecurity === 'ssl_tls' || b.imapSecurity === 'starttls' ? b.imapSecurity : null;
  const password = typeof b.password === 'string' ? b.password : undefined;
  const active = typeof b.active === 'boolean' ? b.active : true;

  if (!label || label.length > 100) return { ok: false, error: 'Nazwa skrzynki musi mieć od 1 do 100 znaków.' };
  if (!EMAIL_REGEX.test(email) || email.length > 254) return { ok: false, error: 'Podaj poprawny adres e-mail.' };
  if (!HOST_REGEX.test(smtpHost) || isBlockedHost(smtpHost)) {
    return { ok: false, error: 'Podaj poprawny publiczny adres hosta SMTP.' };
  }
  if (!HOST_REGEX.test(imapHost) || isBlockedHost(imapHost)) {
    return { ok: false, error: 'Podaj poprawny publiczny adres hosta IMAP.' };
  }
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    return { ok: false, error: 'Port SMTP musi być liczbą całkowitą 1–65535.' };
  }
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) {
    return { ok: false, error: 'Port IMAP musi być liczbą całkowitą 1–65535.' };
  }
  if (!smtpSecurity || !imapSecurity) {
    return { ok: false, error: 'Wybierz tryb zabezpieczeń SSL/TLS lub STARTTLS.' };
  }
  if (isCreate && (!password || password.length === 0)) {
    return { ok: false, error: 'Hasło (lub hasło aplikacji) jest wymagane przy dodawaniu skrzynki.' };
  }

  return {
    ok: true,
    data: {
      role,
      label,
      email,
      password: password && password.length > 0 ? password : undefined,
      smtpHost,
      smtpPort,
      smtpSecurity,
      imapHost,
      imapPort,
      imapSecurity,
      active,
    },
  };
}

function resolveAppUrl(req: Request, env: NodeJS.ProcessEnv): string {
  const envUrl = (env.APP_URL ?? '').trim();
  if (envUrl && envUrl !== 'MY_APP_URL') {
    return envUrl.replace(/\/+$/, '');
  }
  const rawProto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto = rawProto === 'http' ? 'http' : 'https';
  const rawHost = String(req.headers['x-forwarded-host'] ?? req.get('host') ?? 'localhost:3000')
    .split(',')[0]
    .trim();
  return `${proto}://${rawHost}`.replace(/\/+$/, '');
}

function buildAllowedEmails(ownership: OwnershipDoc): string[] {
  return Array.from(new Set([ownership.ownerEmail.toLowerCase(), ...ownership.coOwnerEmails.map((e) => e.toLowerCase())]));
}

interface ResolvedWorkspaceSecrets {
  encryptionKey: string | undefined;
  cronSecret: string | undefined;
  cronTokenForUi: string | undefined;
  status: SecretsStatus;
}

/**
 * Ensures every workspace (both root and personal per-user workspaces) has auto-generated
 * AES-256-GCM encryption key and Cron bearer token persisted in Firestore.
 *
 * - On the root workspace, valid server env vars (ENCRYPTION_KEY / CRON_SECRET) still take
 *   precedence so existing deployments keep decrypting previously saved mailboxes seamlessly.
 * - On personal workspaces (/users/{uid}/...), keys are ALWAYS isolated and auto-generated per user.
 * - encryptionKey is NEVER returned to the browser; cronTokenForUi is returned only when auto-managed.
 */
async function ensureWorkspaceRuntimeSecrets(
  store: WarmupStore,
  ownerUid: string,
  isPersonalWorkspace: boolean,
  env: NodeJS.ProcessEnv
): Promise<ResolvedWorkspaceSecrets> {
  const geminiKey = (env.GEMINI_API_KEY ?? '').trim();
  const hasGeminiKey = Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY');

  let doc = await store.getRuntimeSecrets();
  if (!doc) {
    const nowIso = new Date().toISOString();
    const candidate: RuntimeSecretsDoc = {
      ownerUid,
      encryptionKey: crypto.randomBytes(32).toString('hex'),
      cronSecret: crypto.randomBytes(24).toString('hex'),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const res = await store.createRuntimeSecretsAtomic(candidate);
    if (res.created) {
      doc = candidate;
    } else {
      doc = await store.getRuntimeSecrets();
    }
  }

  if (isPersonalWorkspace) {
    const encryptionKey = doc?.encryptionKey;
    const cronSecret = doc?.cronSecret;
    return {
      encryptionKey,
      cronSecret,
      cronTokenForUi: cronSecret,
      status: {
        hasEncryptionKey: Boolean(encryptionKey),
        encryptionKeyValid: Boolean(encryptionKey),
        encryptionKeySource: encryptionKey ? 'auto' : 'missing',
        hasCronSecret: Boolean(cronSecret && cronSecret.length >= 16),
        cronSecretSource: cronSecret && cronSecret.length >= 16 ? 'auto' : 'missing',
        hasGeminiKey,
      },
    };
  }

  // Root workspace: honor explicit env overrides when present; otherwise auto-use stored keys
  const envEnc = validateEncryptionKeyStatus(env.ENCRYPTION_KEY);
  const envCron = (env.CRON_SECRET ?? '').trim();

  let encryptionKey: string | undefined;
  let encryptionKeySource: 'env' | 'auto' | 'missing' = 'missing';
  let hasEncryptionKey = false;
  let encryptionKeyValid = false;
  let encryptionKeyError: string | undefined;

  if (envEnc.present) {
    hasEncryptionKey = true;
    encryptionKeyValid = envEnc.valid;
    encryptionKeyError = envEnc.error;
    encryptionKeySource = 'env';
    encryptionKey = envEnc.valid ? env.ENCRYPTION_KEY!.trim() : env.ENCRYPTION_KEY;
  } else if (doc?.encryptionKey) {
    hasEncryptionKey = true;
    encryptionKeyValid = true;
    encryptionKeySource = 'auto';
    encryptionKey = doc.encryptionKey;
  }

  let cronSecret: string | undefined;
  let cronTokenForUi: string | undefined;
  let cronSecretSource: 'env' | 'auto' | 'missing' = 'missing';

  if (envCron.length >= 16) {
    cronSecret = envCron;
    cronSecretSource = 'env';
    // Do not expose server .env secret in browser responses
    cronTokenForUi = undefined;
  } else if (doc?.cronSecret && doc.cronSecret.length >= 16) {
    cronSecret = doc.cronSecret;
    cronTokenForUi = doc.cronSecret;
    cronSecretSource = 'auto';
  }

  return {
    encryptionKey,
    cronSecret,
    cronTokenForUi,
    status: {
      hasEncryptionKey,
      encryptionKeyValid,
      encryptionKeyError,
      encryptionKeySource,
      hasCronSecret: Boolean(cronSecret && cronSecret.length >= 16),
      cronSecretSource,
      hasGeminiKey,
    },
  };
}

interface WorkspaceContext {
  user: VerifiedUser;
  store: WarmupStore;
  ownership: OwnershipDoc;
  workspaceId: string;
  isPersonalWorkspace: boolean;
}

export function createApiApp(deps: ApiAppDependencies = {}): Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));

  const verifyToken = deps.verifyToken ?? createFirebaseTokenVerifier();
  const createUserStore =
    deps.createUserStore ??
    ((idToken: string, workspacePrefix = '') => new FirestoreRestStore(idToken, undefined, workspacePrefix));
  const getEnv = deps.getEnv ?? (() => process.env);
  const createCronStore =
    deps.createCronStore ??
    (async (workspacePrefix = '') => {
      const token = await resolveServerFirestoreAccessToken(getEnv());
      if (!token) return null;
      return new FirestoreRestStore(token, undefined, workspacePrefix);
    });
  const mailAdapter = deps.mailAdapter ?? new RealMailTransportAdapter();

  async function initPersonalWorkspace(
    user: VerifiedUser,
    idToken: string,
    allowAutoProvision: boolean
  ): Promise<WorkspaceContext | null> {
    const personalPrefix = `users/${user.uid}`;
    const personalStore = createUserStore(idToken, personalPrefix);
    let ownership = await personalStore.getOwnership();

    if (!ownership) {
      if (!allowAutoProvision) {
        return null;
      }
      const nowIso = new Date().toISOString();
      const candidate: OwnershipDoc = {
        ownerUid: user.uid,
        ownerEmail: user.email,
        coOwnerEmails: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const claimed = await personalStore.createOwnershipAtomic(candidate);
      ownership = claimed.created ? candidate : await personalStore.getOwnership();
      if (!ownership) return null;

      if (claimed.created) {
        const defaultSettings = createDefaultSettings(user.uid, [user.email]);
        await personalStore.saveSettings(defaultSettings);
        await personalStore.appendLog({
          ownerUid: user.uid,
          allowedEmails: [user.email],
          level: 'info',
          category: 'auth',
          message: `Utworzono prywatną przestrzeń roboczą (${user.email}).`,
          createdAt: nowIso,
        });
      }
    }

    return {
      user,
      store: personalStore,
      ownership,
      workspaceId: user.uid,
      isPersonalWorkspace: true,
    };
  }

  async function authenticateWorkspace(
    req: Request,
    res: Response,
    options: { allowInitialClaim?: boolean } = {}
  ): Promise<WorkspaceContext | null> {
    const idToken = extractBearerToken(req.headers.authorization);
    if (!idToken) {
      res.status(401).json({ error: 'Wymagane logowanie kontem Google.' });
      return null;
    }

    let user: VerifiedUser;
    try {
      user = await verifyToken(idToken);
    } catch {
      res.status(401).json({ error: 'Sesja wygasła lub token Google jest nieprawidłowy.' });
      return null;
    }

    const rootStore = createUserStore(idToken, '');

    try {
      let rootOwnership: OwnershipDoc | null = null;
      let rootDenied = false;

      try {
        rootOwnership = await rootStore.getOwnership();
      } catch (err) {
        if (err instanceof FirestorePermissionError) {
          // Another Google account already owns the root workspace — route cleanly to this user's isolated space
          rootDenied = true;
        } else {
          throw err;
        }
      }

      if (!rootDenied && !rootOwnership) {
        if (!options.allowInitialClaim) {
          res.status(403).json({ error: 'Najpierw zainicjalizuj sesję.' });
          return null;
        }
        const nowIso = new Date().toISOString();
        const candidate: OwnershipDoc = {
          ownerUid: user.uid,
          ownerEmail: user.email,
          coOwnerEmails: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const claimed = await rootStore.createOwnershipAtomic(candidate);
        if (claimed.created) {
          const defaultSettings = createDefaultSettings(user.uid, [user.email]);
          await rootStore.saveSettings(defaultSettings);
          await rootStore.appendLog({
            ownerUid: user.uid,
            allowedEmails: [user.email],
            level: 'info',
            category: 'auth',
            message: `Zarejestrowano głównego właściciela aplikacji (${user.email}).`,
            createdAt: nowIso,
          });
          return {
            user,
            store: rootStore,
            ownership: candidate,
            workspaceId: 'root',
            isPersonalWorkspace: false,
          };
        }
        // Lost initial claim race — fall through to isolated personal workspace
        rootDenied = true;
      }

      if (!rootDenied && rootOwnership) {
        const isPrimary = rootOwnership.ownerUid === user.uid;
        const isCoOwner = rootOwnership.coOwnerEmails
          .map((e) => e.toLowerCase())
          .includes(user.email.toLowerCase());
        if (isPrimary || isCoOwner) {
          return {
            user,
            store: rootStore,
            ownership: rootOwnership,
            workspaceId: 'root',
            isPersonalWorkspace: false,
          };
        }
      }

      // User is not the root owner or co-owner -> route to their strictly isolated personal workspace (/users/{uid}/...)
      const personalCtx = await initPersonalWorkspace(user, idToken, Boolean(options.allowInitialClaim));
      if (!personalCtx) {
        res.status(403).json({
          error: 'Nie udało się zainicjalizować Twojej prywatnej przestrzeni roboczej. Zaloguj się ponownie.',
        });
        return null;
      }
      return personalCtx;
    } catch (err) {
      if (err instanceof FirestorePermissionError) {
        res.status(403).json({
          error: 'Brak uprawnień Firestore dla Twojego konta Google.',
        });
        return null;
      }
      const msg = sanitizeForLogs(err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: `Błąd dostępu do bazy Firestore: ${msg}` });
      return null;
    }
  }

  // --- Health check ---
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // --- Session & Automatic Workspace/Keys Bootstrap ---
  app.post('/api/auth/session', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res, { allowInitialClaim: true });
    if (!authCtx) return;

    const { user, store, ownership, workspaceId, isPersonalWorkspace } = authCtx;
    try {
      const resolvedSecrets = await ensureWorkspaceRuntimeSecrets(
        store,
        ownership.ownerUid,
        isPersonalWorkspace,
        getEnv()
      );
      const payload: SessionResponse = {
        uid: user.uid,
        email: user.email,
        isPrimaryOwner: ownership.ownerUid === user.uid,
        workspaceId,
        isPersonalWorkspace,
        ownership,
        secrets: resolvedSecrets.status,
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  // --- Dashboard Snapshot ---
  app.get('/api/dashboard', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { user, store, ownership, workspaceId, isPersonalWorkspace } = authCtx;
    try {
      const env = getEnv();
      const allowedEmails = buildAllowedEmails(ownership);
      let settings = await store.getSettings();
      if (!settings) {
        settings = createDefaultSettings(ownership.ownerUid, allowedEmails);
        await store.saveSettings(settings);
      }

      const resolvedSecrets = await ensureWorkspaceRuntimeSecrets(
        store,
        ownership.ownerUid,
        isPersonalWorkspace,
        env
      );

      const now = new Date();
      const zoned = getZonedParts(now, settings.timezone);
      const { dayIndex, targetLimit } = computeDailyTarget(settings, zoned.dateKey);
      const withinWindow = isWithinSendingWindow(zoned.hour, settings.windowStartHour, settings.windowEndHour);

      const [todayStatsRaw, mailboxes, recentLogs, activeLock] = await Promise.all([
        store.getDailyStats(zoned.dateKey),
        store.listMailboxes(ownership.ownerUid, user.uid, user.email),
        store.listRecentLogs(ownership.ownerUid, user.uid, user.email, 60),
        store.getLock(LOCK_DOC_ID),
      ]);

      const todayStats: DailyStats = todayStatsRaw ?? {
        ownerUid: ownership.ownerUid,
        allowedEmails,
        dateKey: zoned.dateKey,
        dayIndex,
        targetLimit,
        sentCount: 0,
        repliedCount: 0,
        rescuedFromSpamCount: 0,
        fallbackCount: 0,
        errorCount: 0,
        updatedAt: now.toISOString(),
      };

      const validLock = activeLock && activeLock.expiresAtMs > Date.now() ? activeLock : null;

      const payload: DashboardPayload = {
        ownership,
        workspaceId,
        isPersonalWorkspace,
        settings,
        todayStats,
        computedSchedule: {
          dateKey: zoned.dateKey,
          dayIndex,
          targetLimit,
          currentHour: zoned.hour,
          withinWindow,
          nextAllowedSendAt: settings.nextAllowedSendAt || undefined,
        },
        mailboxes,
        recentLogs,
        activeLock: validLock,
        secrets: resolvedSecrets.status,
        cronToken: resolvedSecrets.cronTokenForUi,
        appUrl: resolveAppUrl(req, env),
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  // --- Rotate Auto-Generated Cron Token ---
  app.post('/api/cron/rotate-secret', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { store, ownership, isPersonalWorkspace } = authCtx;
    const env = getEnv();

    try {
      const current = await ensureWorkspaceRuntimeSecrets(store, ownership.ownerUid, isPersonalWorkspace, env);
      if (current.status.cronSecretSource === 'env') {
        res.status(400).json({
          error:
            'CRON_SECRET jest obecnie nadpisany zmienną środowiskową serwera (.env). Usuń CRON_SECRET z .env, aby korzystać z automatycznej rotacji tokenu w panelu.',
        });
        return;
      }

      const newCronSecret = crypto.randomBytes(24).toString('hex');
      const nowIso = new Date().toISOString();
      await store.updateRuntimeSecretsCron(newCronSecret, nowIso);
      await store.appendLog({
        ownerUid: ownership.ownerUid,
        allowedEmails: buildAllowedEmails(ownership),
        level: 'info',
        category: 'auth',
        message: 'Wygenerowano nowy token autoryzacji Cron dla tej przestrzeni roboczej.',
        createdAt: nowIso,
      });

      res.json({ cronToken: newCronSecret });
    } catch (err) {
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  // --- Update Settings & Co-Owners ---
  app.put('/api/settings', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { user, store, ownership, isPersonalWorkspace } = authCtx;
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      let currentOwnership = ownership;
      if (Array.isArray(body.coOwnerEmails)) {
        if (isPersonalWorkspace) {
          res.status(400).json({
            error: 'Każde konto Google ma już własną prywatną przestrzeń roboczą — współwłaściciele dotyczą wyłącznie przestrzeni głównej.',
          });
          return;
        }
        if (ownership.ownerUid !== user.uid) {
          res.status(403).json({ error: 'Tylko główny właściciel może zmieniać listę współwłaścicieli.' });
          return;
        }
        const cleaned = Array.from(
          new Set(
            body.coOwnerEmails
              .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
              .filter((v) => v.length > 0 && v !== ownership.ownerEmail.toLowerCase())
          )
        );
        if (cleaned.length > 10) {
          res.status(400).json({ error: 'Można dodać maksymalnie 10 współwłaścicieli.' });
          return;
        }
        for (const email of cleaned) {
          if (!EMAIL_REGEX.test(email) || email.length > 254) {
            res.status(400).json({ error: `Nieprawidłowy adres e-mail współwłaściciela: ${email}` });
            return;
          }
        }
        const nowIso = new Date().toISOString();
        await store.updateOwnershipCoOwners(cleaned, nowIso);
        currentOwnership = { ...ownership, coOwnerEmails: cleaned, updatedAt: nowIso };
      }

      const allowedEmails = buildAllowedEmails(currentOwnership);
      const existing = (await store.getSettings()) ?? createDefaultSettings(currentOwnership.ownerUid, allowedEmails);

      const enabled = typeof body.enabled === 'boolean' ? body.enabled : existing.enabled;
      const startDailyCount = body.startDailyCount !== undefined ? Number(body.startDailyCount) : existing.startDailyCount;
      const dailyIncrement = body.dailyIncrement !== undefined ? Number(body.dailyIncrement) : existing.dailyIncrement;
      const maxDailyCap = body.maxDailyCap !== undefined ? Number(body.maxDailyCap) : existing.maxDailyCap;
      const minDelayMinutes = body.minDelayMinutes !== undefined ? Number(body.minDelayMinutes) : existing.minDelayMinutes;
      const maxDelayMinutes = body.maxDelayMinutes !== undefined ? Number(body.maxDelayMinutes) : existing.maxDelayMinutes;
      const windowStartHour = body.windowStartHour !== undefined ? Number(body.windowStartHour) : existing.windowStartHour;
      const windowEndHour = body.windowEndHour !== undefined ? Number(body.windowEndHour) : existing.windowEndHour;
      const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : existing.timezone;
      const messageFormat: MessageFormat =
        body.messageFormat === 'plain' || body.messageFormat === 'light_html'
          ? body.messageFormat
          : existing.messageFormat;
      const aiModel = typeof body.aiModel === 'string' && body.aiModel.trim().length > 0
        ? body.aiModel.trim().slice(0, 80)
        : existing.aiModel;
      const startDateKey =
        typeof body.startDateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.startDateKey)
          ? body.startDateKey
          : existing.startDateKey;

      if (!Number.isInteger(startDailyCount) || startDailyCount < 1 || startDailyCount > 200) {
        res.status(400).json({ error: 'Liczba maili na start musi być w zakresie 1–200.' });
        return;
      }
      if (!Number.isInteger(dailyIncrement) || dailyIncrement < 0 || dailyIncrement > 50) {
        res.status(400).json({ error: 'Dzienny przyrost musi być w zakresie 0–50.' });
        return;
      }
      if (!Number.isInteger(maxDailyCap) || maxDailyCap < 1 || maxDailyCap > 500) {
        res.status(400).json({ error: 'Maksymalny dzienny limit (cap) musi być w zakresie 1–500.' });
        return;
      }
      if (!Number.isInteger(minDelayMinutes) || minDelayMinutes < 1 || minDelayMinutes > 1440) {
        res.status(400).json({ error: 'Minimalny odstęp musi wynosić 1–1440 minut.' });
        return;
      }
      if (!Number.isInteger(maxDelayMinutes) || maxDelayMinutes < minDelayMinutes || maxDelayMinutes > 1440) {
        res.status(400).json({ error: 'Maksymalny odstęp musi być >= minimalnemu (maks. 1440 min).' });
        return;
      }
      if (!Number.isInteger(windowStartHour) || windowStartHour < 0 || windowStartHour > 23) {
        res.status(400).json({ error: 'Godzina rozpoczęcia okna musi być w zakresie 0–23.' });
        return;
      }
      if (!Number.isInteger(windowEndHour) || windowEndHour <= windowStartHour || windowEndHour > 24) {
        res.status(400).json({ error: 'Godzina zakończenia okna musi być większa od początkowej (maks. 24).' });
        return;
      }
      if (!isValidTimezone(timezone)) {
        res.status(400).json({ error: `Nieznana strefa czasowa IANA: ${timezone}` });
        return;
      }

      const updated: WarmupSettings = {
        ...existing,
        ownerUid: currentOwnership.ownerUid,
        allowedEmails,
        enabled,
        startDateKey,
        startDailyCount,
        dailyIncrement,
        maxDailyCap,
        minDelayMinutes,
        maxDelayMinutes,
        windowStartHour,
        windowEndHour,
        timezone,
        messageFormat,
        aiModel,
        updatedAt: new Date().toISOString(),
      };

      await store.saveSettings(updated);

      // Keep mailbox allowedEmails synced if co-owners changed
      if (Array.isArray(body.coOwnerEmails)) {
        const boxes = await store.listMailboxes(currentOwnership.ownerUid, user.uid, user.email);
        for (const box of boxes) {
          await store.saveMailbox({ ...box, allowedEmails, updatedAt: updated.updatedAt });
        }
      }

      res.json({ settings: updated, ownership: currentOwnership });
    } catch (err) {
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  // --- Test Gemini AI ---
  app.post('/api/ai/test', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { store, ownership } = authCtx;
    const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : undefined;
    const settings = await store.getSettings();
    const model = requestedModel || settings?.aiModel;

    const result = await testGeminiConnection({
      model,
      caller: deps.aiCaller,
    });

    await store.appendLog({
      ownerUid: ownership.ownerUid,
      allowedEmails: buildAllowedEmails(ownership),
      level: result.ok ? 'info' : 'warn',
      category: 'ai',
      message: sanitizeForLogs(`Test Gemini (${result.model}): ${result.message}`),
      createdAt: new Date().toISOString(),
    });

    res.json(result);
  });

  // --- Create / Upsert Mailbox ---
  app.post('/api/mailboxes', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { store, ownership, isPersonalWorkspace } = authCtx;
    const isPrimary = req.body?.role === 'primary';
    const existingPrimary = isPrimary ? await store.getMailbox('primary') : null;
    const validation = validateMailboxInput(req.body, !existingPrimary);

    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const input = validation.data;
    if (input.role === 'helper') {
      const existingList = await store.listMailboxes(ownership.ownerUid, authCtx.user.uid, authCtx.user.email);
      if (existingList.some((m) => m.role === 'helper' && m.email.toLowerCase() === input.email.toLowerCase())) {
        res.status(409).json({ error: `Skrzynka pomocnicza ${input.email} już istnieje na liście.` });
        return;
      }
    }

    const resolvedSecrets = await ensureWorkspaceRuntimeSecrets(
      store,
      ownership.ownerUid,
      isPersonalWorkspace,
      getEnv()
    );
    let encryptedPassword: string | undefined;

    if (input.password) {
      try {
        encryptedPassword = encryptSecret(input.password, resolvedSecrets.encryptionKey);
      } catch (err) {
        if (err instanceof EncryptionKeyError) {
          res.status(400).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: 'Błąd szyfrowania hasła skrzynki.' });
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const id = input.role === 'primary' ? 'primary' : `mb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const mailbox: MailboxPublic = {
      id,
      ownerUid: ownership.ownerUid,
      allowedEmails: buildAllowedEmails(ownership),
      role: input.role,
      label: input.label,
      email: input.email,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecurity: input.smtpSecurity,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecurity: input.imapSecurity,
      active: input.active ?? true,
      hasPassword: Boolean(encryptedPassword || existingPrimary?.hasPassword),
      lastTestedAt: existingPrimary?.lastTestedAt ?? '',
      lastTestStatus: existingPrimary?.lastTestStatus ?? 'none',
      lastTestMessage: existingPrimary?.lastTestMessage ?? '',
      lastCheckedAt: existingPrimary?.lastCheckedAt ?? '',
      createdAt: existingPrimary?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    try {
      await store.saveMailbox(mailbox, encryptedPassword);
      res.status(existingPrimary ? 200 : 201).json({ mailbox });
    } catch (err) {
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  // --- Update Mailbox ---
  app.put('/api/mailboxes/:id', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { store, ownership, isPersonalWorkspace } = authCtx;
    const mailboxId = String(req.params.id ?? '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mailboxId)) {
      res.status(400).json({ error: 'Nieprawidłowy identyfikator skrzynki.' });
      return;
    }

    const existing = await store.getMailbox(mailboxId);
    if (!existing) {
      res.status(404).json({ error: 'Nie znaleziono wskazanej skrzynki.' });
      return;
    }

    const mergedBody = {
      ...existing,
      ...(req.body ?? {}),
      role: existing.role,
    };
    const validation = validateMailboxInput(mergedBody, false);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const input = validation.data;
    const resolvedSecrets = await ensureWorkspaceRuntimeSecrets(
      store,
      ownership.ownerUid,
      isPersonalWorkspace,
      getEnv()
    );
    let encryptedPassword: string | undefined;

    if (input.password) {
      try {
        encryptedPassword = encryptSecret(input.password, resolvedSecrets.encryptionKey);
      } catch (err) {
        if (err instanceof EncryptionKeyError) {
          res.status(400).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: 'Błąd szyfrowania hasła skrzynki.' });
        return;
      }
    }

    const updated: MailboxPublic = {
      ...existing,
      allowedEmails: buildAllowedEmails(ownership),
      label: input.label,
      email: input.email,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecurity: input.smtpSecurity,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecurity: input.imapSecurity,
      active: input.active ?? existing.active,
      hasPassword: Boolean(encryptedPassword || existing.hasPassword),
      updatedAt: new Date().toISOString(),
    };

    try {
      await store.saveMailbox(updated, encryptedPassword);
      res.json({ mailbox: updated });
    } catch (err) {
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  // --- Delete Helper Mailbox ---
  app.delete('/api/mailboxes/:id', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { store } = authCtx;
    const mailboxId = String(req.params.id ?? '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mailboxId)) {
      res.status(400).json({ error: 'Nieprawidłowy identyfikator skrzynki.' });
      return;
    }

    try {
      await store.deleteMailbox(mailboxId);
      res.json({ deleted: true, id: mailboxId });
    } catch (err) {
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  // --- Test Mailbox SMTP/IMAP ---
  app.post('/api/mailboxes/:id/test', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { store, ownership, isPersonalWorkspace } = authCtx;
    const mailboxId = String(req.params.id ?? '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mailboxId)) {
      res.status(400).json({ error: 'Nieprawidłowy identyfikator skrzynki.' });
      return;
    }

    const mailbox = await store.getMailbox(mailboxId);
    if (!mailbox) {
      res.status(404).json({ error: 'Nie znaleziono wskazanej skrzynki.' });
      return;
    }

    const encrypted = await store.getMailboxEncryptedPassword(mailboxId);
    if (!encrypted) {
      res.status(400).json({ error: 'Skrzynka nie ma zapisanego hasła.' });
      return;
    }

    const resolvedSecrets = await ensureWorkspaceRuntimeSecrets(
      store,
      ownership.ownerUid,
      isPersonalWorkspace,
      getEnv()
    );

    let password: string;
    try {
      password = decryptSecret(encrypted, resolvedSecrets.encryptionKey);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Błąd odszyfrowania hasła.' });
      return;
    }

    const result = await mailAdapter.testConnection(mailbox, password);
    const summaryMsg = sanitizeForLogs(`${result.smtp.message} | ${result.imap.message}`, [password]);

    await store.saveMailbox({
      ...mailbox,
      lastTestedAt: result.testedAt,
      lastTestStatus: result.ok ? 'ok' : 'error',
      lastTestMessage: summaryMsg,
      updatedAt: result.testedAt,
    });

    await store.appendLog({
      ownerUid: ownership.ownerUid,
      allowedEmails: buildAllowedEmails(ownership),
      level: result.ok ? 'info' : 'error',
      category: 'test',
      message: sanitizeForLogs(`Test ${mailbox.email}: ${summaryMsg}`, [password]),
      createdAt: result.testedAt,
    });

    res.json(result);
  });

  // --- Manual 1-Cycle Run ---
  app.post('/api/warmup/run-now', async (req, res) => {
    const authCtx = await authenticateWorkspace(req, res);
    if (!authCtx) return;

    const { user, store, ownership, isPersonalWorkspace } = authCtx;
    const bypassWindowAndDelay = Boolean(req.body?.bypassWindowAndDelay);

    try {
      const resolvedSecrets = await ensureWorkspaceRuntimeSecrets(
        store,
        ownership.ownerUid,
        isPersonalWorkspace,
        getEnv()
      );
      const result = await executeWarmupCycle({
        store,
        mailAdapter,
        source: 'manual',
        callerUid: user.uid,
        callerEmail: user.email,
        bypassWindowAndDelay,
        encryptionKey: resolvedSecrets.encryptionKey,
        aiCaller: deps.aiCaller,
      });

      const status = result.status === 'skipped_locked' ? 409 : 200;
      res.status(status).json(result);
    } catch (err) {
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  // --- Stateless Cron Tick (cron-job.org, supports root and ?workspace=<uid>) ---
  app.post('/api/cron/tick', async (req, res) => {
    const env = getEnv();
    const rawWorkspace =
      (typeof req.query.workspace === 'string' ? req.query.workspace : undefined) ??
      (typeof req.headers['x-workspace-id'] === 'string' ? req.headers['x-workspace-id'] : undefined) ??
      '';
    const workspaceParam = rawWorkspace.trim();

    if (workspaceParam && workspaceParam !== 'root' && !WORKSPACE_ID_REGEX.test(workspaceParam)) {
      res.status(400).json({ error: 'Nieprawidłowy identyfikator przestrzeni roboczej (?workspace=...).' });
      return;
    }

    const isPersonalWorkspace = Boolean(workspaceParam && workspaceParam !== 'root');
    const workspacePrefix = isPersonalWorkspace ? `users/${workspaceParam}` : '';
    const envCronSecret = (env.CRON_SECRET ?? '').trim();

    // Fast fail on root workspace when server env CRON_SECRET is explicitly set
    if (!isPersonalWorkspace && envCronSecret.length >= 16) {
      const envCheck = verifyCronAuthorization(
        {
          authorization: req.headers.authorization,
          'x-cron-secret': req.headers['x-cron-secret'],
        },
        envCronSecret
      );
      if (!envCheck.ok) {
        res.status(envCheck.status).json({ error: envCheck.error });
        return;
      }
    }

    const store = await createCronStore(workspacePrefix);
    if (!store) {
      res.status(503).json({
        error:
          'Brak poświadczeń konta serwisowego Firebase/GCP. Ustaw FIREBASE_SERVICE_ACCOUNT_JSON (lub GOOGLE_APPLICATION_CREDENTIALS) w pliku .env na własnym serwerze, albo nadaj rolę roles/datastore.user w Cloud Run.',
      });
      return;
    }

    try {
      const runtimeSecrets = await store.getRuntimeSecrets();
      const expectedCronSecret =
        !isPersonalWorkspace && envCronSecret.length >= 16
          ? envCronSecret
          : (runtimeSecrets?.cronSecret ?? '').trim();

      if (!expectedCronSecret) {
        res.status(503).json({
          error:
            'Brak tokenu Cron dla tej przestrzeni roboczej — zaloguj się przynajmniej raz do panelu, aby wygenerować klucze automatycznie.',
        });
        return;
      }

      const cronCheck = verifyCronAuthorization(
        {
          authorization: req.headers.authorization,
          'x-cron-secret': req.headers['x-cron-secret'],
        },
        expectedCronSecret
      );
      if (!cronCheck.ok) {
        res.status(cronCheck.status).json({ error: cronCheck.error });
        return;
      }

      const envEnc = validateEncryptionKeyStatus(env.ENCRYPTION_KEY);
      const effectiveEncryptionKey =
        !isPersonalWorkspace && envEnc.present
          ? env.ENCRYPTION_KEY
          : runtimeSecrets?.encryptionKey;

      const ownership = await store.getOwnership();
      const result = await executeWarmupCycle({
        store,
        mailAdapter,
        source: 'cron',
        callerUid: ownership?.ownerUid ?? (isPersonalWorkspace ? workspaceParam : 'cron-system'),
        callerEmail: ownership?.ownerEmail ?? '',
        bypassWindowAndDelay: false,
        encryptionKey: effectiveEncryptionKey,
        aiCaller: deps.aiCaller,
      });

      res.status(200).json(result);
    } catch (err) {
      if (err instanceof FirestorePermissionError) {
        res.status(503).json({
          error:
            'Konto serwisowe nie ma uprawnień do Firestore. Ustaw FIREBASE_SERVICE_ACCOUNT_JSON w pliku .env lub nadaj kontu serwisowemu Cloud Run rolę roles/datastore.user.',
        });
        return;
      }
      res.status(500).json({ error: sanitizeForLogs(err instanceof Error ? err.message : String(err)) });
    }
  });

  return app;
}
