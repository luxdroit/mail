import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { MailboxPublic, MailboxTestResult, WarmupThread } from '../shared/types';
import { normalizeMessageId, sanitizeForLogs } from './crypto';
import { detectSpamFolder, rescueMessageToInbox } from './spamDetector';

export interface OutgoingEmailParams {
  mailbox: MailboxPublic;
  password: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface FoundIncomingMessage {
  thread: WarmupThread;
  /** The actual Message-ID observed on the receiving IMAP server (may differ if SMTP rewrote it). */
  receivedMessageId?: string;
  foundInSpam: boolean;
  rescuedMethod?: 'moved' | 'copied_and_expunged';
  parsedSnippet: string;
}

export interface MailTransportAdapter {
  testConnection(mailbox: MailboxPublic, password: string): Promise<MailboxTestResult>;
  sendEmail(params: OutgoingEmailParams): Promise<{ messageId: string }>;
  checkHelperAndRescue(params: {
    helper: MailboxPublic;
    password: string;
    primaryEmail: string;
    pendingThreads: WarmupThread[];
    deadlineMs: number;
  }): Promise<{
    spamFolderDetected: string | null;
    matched: FoundIncomingMessage[];
    warnings: string[];
    pendingCount?: number;
  }>;
}

export interface EnvelopeCandidate {
  uid: number;
  messageId?: string;
  subject?: string;
  date?: Date | string;
  fromAddresses: string[];
}

export function normalizeSubjectForMatch(subject: string | undefined | null): string {
  return String(subject ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function buildDomainMessageId(senderEmail: string): string {
  const domainPart = senderEmail.split('@')[1]?.trim().toLowerCase() || 'mailpulse.local';
  const safeDomain = /^[a-z0-9.-]+$/.test(domainPart) ? domainPart : 'mailpulse.local';
  return `<${crypto.randomUUID()}@${safeDomain}>`;
}

/**
 * Matches an incoming IMAP envelope against pending warmup threads for a helper mailbox.
 * 1. Primary match: exact normalized Message-ID (standard RFC 5322 thread tracking).
 * 2. Fallback match (when an SMTP relay such as Gmail/Exchange/home.pl rewrites Message-ID):
 *    sender matches primaryEmail + exact normalized Subject + message date >= sentAt - 15 min.
 */
export function matchEnvelopeToPendingThread(
  candidate: EnvelopeCandidate,
  primaryEmail: string,
  pendingThreads: WarmupThread[]
): WarmupThread | null {
  const normMsgId = candidate.messageId ? normalizeMessageId(candidate.messageId) : '';
  if (normMsgId) {
    const byId = pendingThreads.find((t) => normalizeMessageId(t.messageId) === normMsgId);
    if (byId) return byId;
  }

  // Fallback when SMTP server rewrote Message-ID during transit
  const primaryLower = primaryEmail.trim().toLowerCase();
  const fromMatches =
    candidate.fromAddresses.length === 0 ||
    candidate.fromAddresses.some((addr) => addr.trim().toLowerCase() === primaryLower);
  if (!fromMatches) return null;

  const normSubj = normalizeSubjectForMatch(candidate.subject);
  if (!normSubj) return null;

  const candidateDateMs = candidate.date ? new Date(candidate.date).getTime() : Number.NaN;
  const CLOCK_SKEW_MS = 15 * 60_000;

  for (const thread of pendingThreads) {
    if (normalizeSubjectForMatch(thread.subject) !== normSubj) continue;
    if (!Number.isNaN(candidateDateMs)) {
      const sentMs = Date.parse(thread.sentAt);
      if (!Number.isNaN(sentMs) && candidateDateMs < sentMs - CLOCK_SKEW_MS) {
        continue;
      }
    }
    return thread;
  }

  return null;
}

function createSmtpTransporter(mailbox: MailboxPublic, password: string) {
  const isSsl = mailbox.smtpSecurity === 'ssl_tls';
  return nodemailer.createTransport({
    host: mailbox.smtpHost,
    port: mailbox.smtpPort,
    secure: isSsl,
    requireTLS: !isSsl,
    auth: {
      user: mailbox.email,
      pass: password,
    },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 10_000,
  });
}

function createImapClient(mailbox: MailboxPublic, password: string) {
  const isSsl = mailbox.imapSecurity === 'ssl_tls';
  return new ImapFlow({
    host: mailbox.imapHost,
    port: mailbox.imapPort,
    secure: isSsl,
    auth: {
      user: mailbox.email,
      pass: password,
    },
    logger: false,
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 10_000,
  });
}

export class RealMailTransportAdapter implements MailTransportAdapter {
  async testConnection(mailbox: MailboxPublic, password: string): Promise<MailboxTestResult> {
    const testedAt = new Date().toISOString();

    // 1. SMTP test
    const smtpStart = Date.now();
    let smtpResult = { ok: false, message: '', latencyMs: 0 };
    try {
      const transporter = createSmtpTransporter(mailbox, password);
      await transporter.verify();
      transporter.close();
      smtpResult = {
        ok: true,
        message: `SMTP OK (${mailbox.smtpHost}:${mailbox.smtpPort}, ${mailbox.smtpSecurity === 'ssl_tls' ? 'SSL/TLS' : 'STARTTLS'})`,
        latencyMs: Date.now() - smtpStart,
      };
    } catch (err) {
      const msg = sanitizeForLogs(err instanceof Error ? err.message : String(err), [password]);
      smtpResult = {
        ok: false,
        message: `Błąd SMTP: ${msg}`,
        latencyMs: Date.now() - smtpStart,
      };
    }

    // 2. IMAP test + Spam folder discovery
    const imapStart = Date.now();
    let imapResult: MailboxTestResult['imap'] = { ok: false, message: '', latencyMs: 0, spamFolder: null };
    const imap = createImapClient(mailbox, password);
    try {
      await imap.connect();
      const boxes = await imap.list();
      const spam = detectSpamFolder(
        boxes.map((b) => ({
          path: b.path,
          name: b.name,
          delimiter: b.delimiter,
          specialUse: b.specialUse,
          flags: b.flags,
        }))
      );
      await imap.logout();
      imapResult = {
        ok: true,
        message: spam
          ? `IMAP OK — wykryto folder Spam: ${spam.path}`
          : 'IMAP OK — brak osobnego folderu Spam (sprawdzany będzie INBOX).',
        latencyMs: Date.now() - imapStart,
        spamFolder: spam?.path ?? null,
      };
    } catch (err) {
      try {
        imap.close();
      } catch {
        // Ignore close error
      }
      const msg = sanitizeForLogs(err instanceof Error ? err.message : String(err), [password]);
      imapResult = {
        ok: false,
        message: `Błąd IMAP: ${msg}`,
        latencyMs: Date.now() - imapStart,
        spamFolder: null,
      };
    }

    return {
      ok: smtpResult.ok && imapResult.ok,
      smtp: smtpResult,
      imap: imapResult,
      testedAt,
    };
  }

  async sendEmail(params: OutgoingEmailParams): Promise<{ messageId: string }> {
    const transporter = createSmtpTransporter(params.mailbox, params.password);
    const explicitMessageId = buildDomainMessageId(params.mailbox.email);
    try {
      const info = await transporter.sendMail({
        from: params.mailbox.email,
        to: params.to,
        subject: params.subject,
        text: params.text,
        messageId: explicitMessageId,
        ...(params.html ? { html: params.html } : {}),
        ...(params.inReplyTo ? { inReplyTo: params.inReplyTo } : {}),
        ...(params.references && params.references.length > 0 ? { references: params.references } : {}),
      });
      return { messageId: info.messageId || explicitMessageId };
    } finally {
      transporter.close();
    }
  }

  async checkHelperAndRescue(params: {
    helper: MailboxPublic;
    password: string;
    primaryEmail: string;
    pendingThreads: WarmupThread[];
    deadlineMs: number;
  }): Promise<{
    spamFolderDetected: string | null;
    matched: FoundIncomingMessage[];
    warnings: string[];
    pendingCount: number;
  }> {
    const warnings: string[] = [];
    const matched: FoundIncomingMessage[] = [];
    const remainingThreads = [...params.pendingThreads];
    const pendingCount = remainingThreads.length;

    const imap = createImapClient(params.helper, params.password);
    let spamFolderPath: string | null = null;

    try {
      await imap.connect();
      const boxes = await imap.list();
      const spamBox = detectSpamFolder(
        boxes.map((b) => ({
          path: b.path,
          name: b.name,
          delimiter: b.delimiter,
          specialUse: b.specialUse,
          flags: b.flags,
        }))
      );
      spamFolderPath = spamBox?.path ?? null;

      if (remainingThreads.length === 0) {
        await imap.logout();
        return { spamFolderDetected: spamFolderPath, matched, warnings, pendingCount };
      }

      const scanFolder = async (folderPath: string, isSpam: boolean) => {
        if (Date.now() >= params.deadlineMs || remainingThreads.length === 0) return;

        let lock: { release: () => void } | null = null;
        try {
          lock = await imap.getMailboxLock(folderPath);

          // Step 1: Try IMAP SEARCH FROM primaryEmail first.
          // If server search returns empty (common with some providers / fresh delivery),
          // fall back to fetching lightweight envelopes of the 25 newest messages.
          let envelopes = [] as Awaited<ReturnType<ImapFlow['fetchAll']>>;
          let searchUids: number[] = [];
          try {
            const found = await imap.search({ from: params.primaryEmail }, { uid: true });
            if (Array.isArray(found) && found.length > 0) {
              searchUids = found.slice(-25);
            }
          } catch {
            // Fall through to recent envelope scan
          }

          if (searchUids.length > 0) {
            envelopes = await imap.fetchAll(searchUids, { envelope: true, uid: true }, { uid: true });
          } else {
            const totalExists = typeof imap.mailbox === 'object' && imap.mailbox ? imap.mailbox.exists : 0;
            if (totalExists > 0) {
              const startSeq = Math.max(1, totalExists - 24);
              envelopes = await imap.fetchAll(`${startSeq}:*`, { envelope: true, uid: true });
            }
          }

          if (envelopes.length === 0) return;

          // Step 2: Match envelopes in memory AFTER fetchAll has completely finished
          // (never issue IMAP commands inside an open imap.fetch() iterator — that deadlocks imapflow).
          const matchedHits: Array<{ uid: number; thread: WarmupThread; receivedMessageId: string }> = [];

          for (const msg of envelopes) {
            if (remainingThreads.length === 0) break;
            const fromAddresses = (msg.envelope?.from ?? [])
              .map((a) => a.address)
              .filter((a): a is string => typeof a === 'string' && a.length > 0);

            const hit = matchEnvelopeToPendingThread(
              {
                uid: msg.uid,
                messageId: msg.envelope?.messageId,
                subject: msg.envelope?.subject,
                date: msg.envelope?.date,
                fromAddresses,
              },
              params.primaryEmail,
              remainingThreads
            );

            if (!hit) continue;

            const idx = remainingThreads.findIndex((t) => t.id === hit.id);
            if (idx >= 0) remainingThreads.splice(idx, 1);

            matchedHits.push({
              uid: msg.uid,
              thread: hit,
              receivedMessageId: msg.envelope?.messageId || hit.messageId,
            });
          }

          // Step 3: Now safely fetch raw body snippet, mark \Seen, and rescue from Spam sequentially
          for (const hit of matchedHits) {
            if (Date.now() >= params.deadlineMs) break;

            let parsedSnippet = hit.thread.bodySnippet ?? '';
            try {
              const fetched = await imap.fetchAll([hit.uid], { source: true, uid: true }, { uid: true });
              const rawSource = fetched[0]?.source;
              if (rawSource) {
                const parsed = await simpleParser(rawSource);
                if (parsed.text) {
                  parsedSnippet = parsed.text.trim().slice(0, 600);
                }
              }
            } catch {
              // Keep stored snippet if parsing fails
            }

            try {
              await imap.messageFlagsAdd(hit.uid, ['\\Seen'], { uid: true });
            } catch (flagErr) {
              warnings.push(
                sanitizeForLogs(
                  `Nie udało się oznaczyć wiadomości jako \\Seen w ${folderPath}: ${flagErr instanceof Error ? flagErr.message : String(flagErr)}`,
                  [params.password]
                )
              );
            }

            let rescuedMethod: 'moved' | 'copied_and_expunged' | undefined;
            if (isSpam) {
              rescuedMethod = await rescueMessageToInbox(imap, hit.uid);
            }

            matched.push({
              thread: hit.thread,
              receivedMessageId: hit.receivedMessageId,
              foundInSpam: isSpam,
              rescuedMethod,
              parsedSnippet,
            });
          }
        } catch (folderErr) {
          warnings.push(
            sanitizeForLogs(
              `Błąd odczytu folderu ${folderPath}: ${folderErr instanceof Error ? folderErr.message : String(folderErr)}`,
              [params.password]
            )
          );
        } finally {
          if (lock) lock.release();
        }
      };

      // Check Spam folder first (if present), then INBOX
      if (spamFolderPath) {
        await scanFolder(spamFolderPath, true);
      } else {
        warnings.push(`Skrzynka ${params.helper.email}: brak wykrytego folderu Spam — sprawdzono wyłącznie INBOX.`);
      }

      await scanFolder('INBOX', false);
      await imap.logout();
    } catch (err) {
      try {
        imap.close();
      } catch {
        // Ignore close errors
      }
      throw new Error(sanitizeForLogs(err instanceof Error ? err.message : String(err), [params.password]));
    }

    return { spamFolderDetected: spamFolderPath, matched, warnings, pendingCount };
  }
}
