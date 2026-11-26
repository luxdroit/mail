export type SecurityMode = 'ssl_tls' | 'starttls';
export type MailboxRole = 'primary' | 'helper';
export type MessageFormat = 'plain' | 'light_html';
export type LogLevel = 'info' | 'warn' | 'error';
export type LogCategory = 'send' | 'imap' | 'reply' | 'ai' | 'cron' | 'auth' | 'test';

export interface OwnershipDoc {
  ownerUid: string;
  ownerEmail: string;
  coOwnerEmails: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WarmupSettings {
  ownerUid: string;
  allowedEmails: string[];
  enabled: boolean;
  startDateKey: string;
  startDailyCount: number;
  dailyIncrement: number;
  maxDailyCap: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  windowStartHour: number;
  windowEndHour: number;
  timezone: string;
  messageFormat: MessageFormat;
  aiModel: string;
  geminiApiKey?: string;
  encryptedGeminiApiKey?: string;
  hasCustomAiKey?: boolean;
  lastSentAt?: string;
  nextAllowedSendAt?: string;
  lastHelperIndex: number;
  updatedAt: string;
}

export interface MailboxPublic {
  id: string;
  ownerUid: string;
  allowedEmails: string[];
  role: MailboxRole;
  label: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SecurityMode;
  imapHost: string;
  imapPort: number;
  imapSecurity: SecurityMode;
  active: boolean;
  hasPassword: boolean;
  lastTestedAt?: string;
  lastTestStatus?: 'ok' | 'error' | 'none';
  lastTestMessage?: string;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailboxInput {
  role: MailboxRole;
  label: string;
  email: string;
  password?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SecurityMode;
  imapHost: string;
  imapPort: number;
  imapSecurity: SecurityMode;
  active?: boolean;
}

export interface WarmupThread {
  id: string;
  ownerUid: string;
  allowedEmails: string[];
  messageId: string;
  primaryMailboxId: string;
  helperMailboxId: string;
  helperEmail: string;
  subject: string;
  bodySnippet?: string;
  format: MessageFormat;
  usedFallback: boolean;
  status: 'sent' | 'replied' | 'failed';
  foundInSpam: boolean;
  sentAt: string;
  repliedAt?: string;
  replyMessageId?: string;
}

export interface DailyStats {
  ownerUid: string;
  allowedEmails: string[];
  dateKey: string;
  dayIndex: number;
  targetLimit: number;
  sentCount: number;
  repliedCount: number;
  rescuedFromSpamCount: number;
  fallbackCount: number;
  errorCount: number;
  updatedAt: string;
}

export interface WarmupLog {
  id: string;
  ownerUid: string;
  allowedEmails: string[];
  level: LogLevel;
  category: LogCategory;
  message: string;
  createdAt: string;
}

export interface ExecutionLock {
  ownerUid: string;
  lockedBy: string;
  source: 'cron' | 'manual';
  acquiredAtMs: number;
  expiresAtMs: number;
}

export interface RuntimeSecretsDoc {
  ownerUid: string;
  encryptionKey: string;
  cronSecret: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretsStatus {
  hasEncryptionKey: boolean;
  encryptionKeyValid: boolean;
  encryptionKeyError?: string;
  encryptionKeySource?: 'env' | 'auto' | 'missing';
  hasCronSecret: boolean;
  cronSecretSource?: 'env' | 'auto' | 'missing';
  hasGeminiKey: boolean;
  geminiKeySource?: 'workspace' | 'env' | 'missing';
}

export interface SessionResponse {
  uid: string;
  email: string;
  isPrimaryOwner: boolean;
  workspaceId: string;
  isPersonalWorkspace: boolean;
  ownership: OwnershipDoc;
  secrets: SecretsStatus;
}

export interface DashboardPayload {
  ownership: OwnershipDoc;
  workspaceId: string;
  isPersonalWorkspace: boolean;
  settings: WarmupSettings;
  todayStats: DailyStats;
  computedSchedule: {
    dateKey: string;
    dayIndex: number;
    targetLimit: number;
    currentHour: number;
    withinWindow: boolean;
    nextAllowedSendAt?: string;
  };
  mailboxes: MailboxPublic[];
  recentLogs: WarmupLog[];
  activeLock: ExecutionLock | null;
  secrets: SecretsStatus;
  cronToken?: string;
  appUrl: string;
}

export interface AiTestResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  fallbackReady: boolean;
  status: 'connected' | 'fallback_rate_limit' | 'fallback_missing_key' | 'fallback_model_error' | 'fallback_network';
  message: string;
  sampleSubject?: string;
}

export interface MailboxTestResult {
  ok: boolean;
  smtp: { ok: boolean; message: string; latencyMs: number };
  imap: { ok: boolean; message: string; latencyMs: number; spamFolder?: string | null };
  testedAt: string;
}

export interface WarmupCycleResult {
  status: 'completed' | 'skipped_locked' | 'skipped_disabled' | 'skipped_not_ready' | 'error';
  runId: string;
  source: 'cron' | 'manual';
  sent: boolean;
  sentTo?: string;
  usedFallback?: boolean;
  checkedHelpers: number;
  repliedCount: number;
  rescuedFromSpamCount: number;
  skippedReason?: string;
  errors: string[];
  durationMs: number;
}

export const RECOMMENDED_AI_MODELS = [
  { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite (Zalecany — szybki, lekki)' },
  { id: 'gemini-4-hydrogen', label: 'gemini-4-hydrogen (Standardowy Flash)' },
  { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (Własny / eksperymentalny)' },
  { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash (Własny / eksperymentalny)' },
] as const;

export const DEFAULT_AI_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_TIMEZONE = 'Europe/Warsaw';
