import crypto from 'node:crypto';
import type { DailyStats, MailboxPublic, WarmupCycleResult, WarmupThread } from '../shared/types';
import { decryptSecret, hashMessageId, sanitizeForLogs } from './crypto';
import {
  computeDailyTarget,
  computeRandomDelayMinutes,
  evaluateSendEligibility,
  getZonedParts,
} from './schedule';
import {
  createDefaultGenAiCaller,
  generateContextualReply,
  generateInitialWarmupEmail,
  type GenAiCaller,
} from './contentService';
import type { WarmupStore } from './firestoreStore';
import { createDefaultSettings } from './firestoreStore';
import type { MailTransportAdapter } from './mailService';

export const LOCK_DOC_ID = 'warmup_tick';
export const LOCK_TTL_MS = 120_000; // 2 minutes
const DEFAULT_SOFT_BUDGET_MS = 22_000;
const MAX_HELPERS_PER_TICK = 3;

export interface ExecuteWarmupOptions {
  store: WarmupStore;
  mailAdapter: MailTransportAdapter;
  source: 'cron' | 'manual';
  callerUid: string;
  callerEmail: string;
  bypassWindowAndDelay?: boolean;
  encryptionKey?: string;
  aiCaller?: GenAiCaller | null;
  now?: Date;
  softBudgetMs?: number;
  rng?: () => number;
}

export async function executeWarmupCycle(options: ExecuteWarmupOptions): Promise<WarmupCycleResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const runId = crypto.randomUUID();
  const softBudgetMs = options.softBudgetMs ?? DEFAULT_SOFT_BUDGET_MS;
  const deadlineMs = startedAt + softBudgetMs;
  const errors: string[] = [];

  const ownership = await options.store.getOwnership();
  if (!ownership) {
    return {
      status: 'skipped_not_ready',
      runId,
      source: options.source,
      sent: false,
      checkedHelpers: 0,
      repliedCount: 0,
      rescuedFromSpamCount: 0,
      skippedReason: 'Aplikacja nie ma jeszcze zarejestrowanego właściciela (zaloguj się przez Google).',
      errors: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const allowedEmails = Array.from(new Set([ownership.ownerEmail, ...ownership.coOwnerEmails]));

  // 1. Acquire transactional Firestore lock (TTL 2 min)
  const lockAttempt = await options.store.acquireLock(
    LOCK_DOC_ID,
    ownership.ownerUid,
    runId,
    options.source,
    LOCK_TTL_MS,
    nowMs
  );

  if (!lockAttempt.acquired) {
    const remainingSec = lockAttempt.existingLock
      ? Math.max(1, Math.ceil((lockAttempt.existingLock.expiresAtMs - nowMs) / 1000))
      : 120;
    const msg = `Pominięto cykl (${options.source}): trwa inne wykonanie (lock aktywny jeszcze ok. ${remainingSec}s).`;
    await options.store.appendLog({
      ownerUid: ownership.ownerUid,
      allowedEmails,
      level: 'warn',
      category: 'cron',
      message: sanitizeForLogs(msg),
      createdAt: now.toISOString(),
    });
    return {
      status: 'skipped_locked',
      runId,
      source: options.source,
      sent: false,
      checkedHelpers: 0,
      repliedCount: 0,
      rescuedFromSpamCount: 0,
      skippedReason: msg,
      errors: [],
      durationMs: Date.now() - startedAt,
    };
  }

  let sent = false;
  let sentTo: string | undefined;
  let usedFallback: boolean | undefined;
  let checkedHelpers = 0;
  let repliedCount = 0;
  let rescuedFromSpamCount = 0;
  let skippedReason: string | undefined;

  try {
    let settings = await options.store.getSettings();
    if (!settings) {
      settings = createDefaultSettings(ownership.ownerUid, allowedEmails, now);
      await options.store.saveSettings(settings);
    }

    // Dynamiczne odszyfrowanie dedykowanego klucza Gemini danego konta
    let workspaceApiKey: string | undefined;
    if (settings.encryptedGeminiApiKey && options.encryptionKey) {
      try {
        workspaceApiKey = decryptSecret(settings.encryptedGeminiApiKey, options.encryptionKey);
      } catch {
        await options.store.appendLog({
          ownerUid: ownership.ownerUid,
          allowedEmails,
          level: 'warn',
          category: 'ai',
          message: 'Błąd odszyfrowania klucza Gemini API — nastąpi próba użycia klucza systemowego lub szablonu fallback.',
          createdAt: now.toISOString(),
        });
      }
    }

    const effectiveAiCaller =
      options.aiCaller !== undefined
        ? options.aiCaller
        : createDefaultGenAiCaller(workspaceApiKey);

    if (!settings.enabled && !options.bypassWindowAndDelay) {
      return {
        status: 'skipped_disabled',
        runId,
        source: options.source,
        sent: false,
        checkedHelpers: 0,
        repliedCount: 0,
        rescuedFromSpamCount: 0,
        skippedReason: 'Warm-up jest wyłączony w harmonogramie.',
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const mailboxes = await options.store.listMailboxes(
      ownership.ownerUid,
      options.callerUid,
      options.callerEmail
    );
    const primary = mailboxes.find((m) => m.role === 'primary');
    const activeHelpers = mailboxes.filter((m) => m.role === 'helper' && m.active && m.hasPassword);

    if (!primary || !primary.hasPassword) {
      const msg = 'Brak skonfigurowanej skrzynki głównej z hasłem.';
      await options.store.appendLog({
        ownerUid: ownership.ownerUid,
        allowedEmails,
        level: 'warn',
        category: 'cron',
        message: msg,
        createdAt: now.toISOString(),
      });
      return {
        status: 'skipped_not_ready',
        runId,
        source: options.source,
        sent: false,
        checkedHelpers: 0,
        repliedCount: 0,
        rescuedFromSpamCount: 0,
        skippedReason: msg,
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    if (activeHelpers.length === 0) {
      const msg = 'Brak aktywnych skrzynek pomocniczych z hasłem.';
      await options.store.appendLog({
        ownerUid: ownership.ownerUid,
        allowedEmails,
        level: 'warn',
        category: 'cron',
        message: msg,
        createdAt: now.toISOString(),
      });
      return {
        status: 'skipped_not_ready',
        runId,
        source: options.source,
        sent: false,
        checkedHelpers: 0,
        repliedCount: 0,
        rescuedFromSpamCount: 0,
        skippedReason: msg,
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const zoned = getZonedParts(now, settings.timezone);
    const { dayIndex, targetLimit } = computeDailyTarget(settings, zoned.dateKey);
    let todayStats: DailyStats =
      (await options.store.getDailyStats(zoned.dateKey)) ?? {
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
    todayStats.dayIndex = dayIndex;
    todayStats.targetLimit = targetLimit;

    // 2. Step A: Outbound — send at most 1 email if schedule permits
    const eligibility = evaluateSendEligibility(settings, todayStats, now, {
      bypassWindowAndDelay: options.bypassWindowAndDelay,
    });

    if (eligibility.eligible) {
      const helperIndex = settings.lastHelperIndex % activeHelpers.length;
      const targetHelper = activeHelpers[helperIndex];
      const encryptedPrimaryPass = await options.store.getMailboxEncryptedPassword(primary.id);
      if (!encryptedPrimaryPass) {
        throw new Error('Brak zaszyfrowanego hasła skrzynki głównej.');
      }

      const primaryPassword = decryptSecret(encryptedPrimaryPass, options.encryptionKey);
      const generated = await generateInitialWarmupEmail({
        model: settings.aiModel,
        format: settings.messageFormat,
        caller: effectiveAiCaller,
        rng: options.rng,
      });

      usedFallback = generated.usedFallback;
      if (generated.usedFallback) {
        todayStats.fallbackCount += 1;
        await options.store.appendLog({
          ownerUid: ownership.ownerUid,
          allowedEmails,
          level: 'warn',
          category: 'ai',
          message: sanitizeForLogs(generated.fallbackReason ?? 'Użyto szablonu fallback dla wiadomości wychodzącej.', [workspaceApiKey || '']),
          createdAt: new Date().toISOString(),
        });
      }

      try {
        const sendRes = await options.mailAdapter.sendEmail({
          mailbox: primary,
          password: primaryPassword,
          to: targetHelper.email,
          subject: generated.subject,
          text: generated.text,
          html: generated.html,
        });

        const threadId = hashMessageId(sendRes.messageId);
        const thread: WarmupThread = {
          id: threadId,
          ownerUid: ownership.ownerUid,
          allowedEmails,
          messageId: sendRes.messageId,
          primaryMailboxId: primary.id,
          helperMailboxId: targetHelper.id,
          helperEmail: targetHelper.email,
          subject: generated.subject,
          bodySnippet: generated.text.slice(0, 600),
          format: settings.messageFormat,
          usedFallback: generated.usedFallback,
          status: 'sent',
          foundInSpam: false,
          sentAt: now.toISOString(),
        };
        await options.store.saveThread(thread);

        const delayMin = computeRandomDelayMinutes(
          settings.minDelayMinutes,
          settings.maxDelayMinutes,
          options.rng
        );
        const nextAllowedIso = new Date(nowMs + delayMin * 60_000).toISOString();

        settings = {
          ...settings,
          lastSentAt: now.toISOString(),
          nextAllowedSendAt: nextAllowedIso,
          lastHelperIndex: (helperIndex + 1) % activeHelpers.length,
          updatedAt: now.toISOString(),
        };
        await options.store.saveSettings(settings);

        todayStats.sentCount += 1;
        todayStats.updatedAt = now.toISOString();
        await options.store.saveDailyStats(todayStats);

        sent = true;
        sentTo = targetHelper.email;

        await options.store.appendLog({
          ownerUid: ownership.ownerUid,
          allowedEmails,
          level: 'info',
          category: 'send',
          message: sanitizeForLogs(
            `Wysłano wiadomość (${settings.messageFormat === 'plain' ? 'Plain Text' : 'Lekki HTML'}) do ${targetHelper.email}. Następny odstęp: ${delayMin} min.`
          ),
          createdAt: new Date().toISOString(),
        });
      } catch (sendErr) {
        const cleanErr = sanitizeForLogs(
          sendErr instanceof Error ? sendErr.message : String(sendErr),
          [primaryPassword, workspaceApiKey || '']
        );
        errors.push(`Wysyłka SMTP: ${cleanErr}`);
        todayStats.errorCount += 1;
        todayStats.updatedAt = new Date().toISOString();
        await options.store.saveDailyStats(todayStats);
        await options.store.appendLog({
          ownerUid: ownership.ownerUid,
          allowedEmails,
          level: 'error',
          category: 'send',
          message: sanitizeForLogs(`Błąd wysyłki do ${targetHelper.email}: ${cleanErr}`),
          createdAt: new Date().toISOString(),
        });
      }
    } else {
      skippedReason = eligibility.reason;
    }

    // 3. Step B: Inbound — rotate least-recently-checked helper mailboxes within soft time budget
    const sortedHelpers = [...activeHelpers].sort((a, b) =>
      (a.lastCheckedAt ?? '').localeCompare(b.lastCheckedAt ?? '')
    );
    const helpersBatch: MailboxPublic[] = sortedHelpers.slice(0, MAX_HELPERS_PER_TICK);

    for (const helper of helpersBatch) {
      if (Date.now() >= deadlineMs) {
        await options.store.appendLog({
          ownerUid: ownership.ownerUid,
          allowedEmails,
          level: 'info',
          category: 'imap',
          message: 'Osiągnięto budżet czasu pojedynczego ticku — pozostałe skrzynki zostaną sprawdzone w kolejnym cyklu.',
          createdAt: new Date().toISOString(),
        });
        break;
      }

      const encryptedHelperPass = await options.store.getMailboxEncryptedPassword(helper.id);
      if (!encryptedHelperPass) continue;

      let helperPassword = '';
      try {
        helperPassword = decryptSecret(encryptedHelperPass, options.encryptionKey);
        const pendingThreads = await options.store.listPendingThreadsForHelper(
          ownership.ownerUid,
          options.callerUid,
          options.callerEmail,
          helper.id
        );

        checkedHelpers += 1;
        const imapRes = await options.mailAdapter.checkHelperAndRescue({
          helper,
          password: helperPassword,
          primaryEmail: primary.email,
          pendingThreads,
          deadlineMs,
        });

        for (const warnMsg of imapRes.warnings) {
          await options.store.appendLog({
            ownerUid: ownership.ownerUid,
            allowedEmails,
            level: 'warn',
            category: 'imap',
            message: sanitizeForLogs(warnMsg, [helperPassword, workspaceApiKey || '']),
            createdAt: new Date().toISOString(),
          });
        }

        // Update helper lastCheckedAt
        await options.store.saveMailbox({
          ...helper,
          lastCheckedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        if (pendingThreads.length > 0 && imapRes.matched.length === 0) {
          await options.store.appendLog({
            ownerUid: ownership.ownerUid,
            allowedEmails,
            level: 'info',
            category: 'imap',
            message: sanitizeForLogs(
              `Skrzynka ${helper.email}: sprawdzono IMAP (oczekujących wątków: ${pendingThreads.length}) — nie znaleziono jeszcze dostarczonej wiadomości do odpowiedzi.`
            ),
            createdAt: new Date().toISOString(),
          });
        }

        // Reply to each matched thread
        for (const match of imapRes.matched) {
          if (Date.now() >= deadlineMs) break;

          if (match.foundInSpam) {
            rescuedFromSpamCount += 1;
            todayStats.rescuedFromSpamCount += 1;
            await options.store.appendLog({
              ownerUid: ownership.ownerUid,
              allowedEmails,
              level: 'warn',
              category: 'imap',
              message: sanitizeForLogs(
                `Wyciągnięto ze Spamu do INBOX (${match.rescuedMethod === 'copied_and_expunged' ? 'fallback COPY+EXPUNGE' : 'MOVE'}) na skrzynce ${helper.email}.`
              ),
              createdAt: new Date().toISOString(),
            });
          }

          const replyGen = await generateContextualReply({
            model: settings.aiModel,
            format: settings.messageFormat,
            originalSubject: match.thread.subject,
            originalSnippet: match.parsedSnippet,
            caller: effectiveAiCaller,
            rng: options.rng,
          });

          if (replyGen.usedFallback) {
            todayStats.fallbackCount += 1;
            await options.store.appendLog({
              ownerUid: ownership.ownerUid,
              allowedEmails,
              level: 'warn',
              category: 'ai',
              message: sanitizeForLogs(replyGen.fallbackReason ?? 'Użyto szablonu fallback dla odpowiedzi.', [workspaceApiKey || '']),
              createdAt: new Date().toISOString(),
            });
          }

          const replySubject = /^re:/i.test(match.thread.subject)
            ? match.thread.subject
            : `Re: ${match.thread.subject}`;

          const replyTargetMessageId = match.receivedMessageId || match.thread.messageId;
          const replyRes = await options.mailAdapter.sendEmail({
            mailbox: helper,
            password: helperPassword,
            to: primary.email,
            subject: replySubject,
            text: replyGen.text,
            html: replyGen.html,
            inReplyTo: replyTargetMessageId,
            references: [replyTargetMessageId],
          });

          await options.store.saveThread({
            ...match.thread,
            status: 'replied',
            foundInSpam: match.foundInSpam,
            repliedAt: new Date().toISOString(),
            replyMessageId: replyRes.messageId,
          });

          repliedCount += 1;
          todayStats.repliedCount += 1;

          await options.store.appendLog({
            ownerUid: ownership.ownerUid,
            allowedEmails,
            level: 'info',
            category: 'reply',
            message: sanitizeForLogs(`Wysłano odpowiedź w wątku ze skrzynki ${helper.email} do ${primary.email}.`),
            createdAt: new Date().toISOString(),
          });
        }
      } catch (helperErr) {
        const cleanErr = sanitizeForLogs(
          helperErr instanceof Error ? helperErr.message : String(helperErr),
          [helperPassword, workspaceApiKey || '']
        );
        errors.push(`IMAP/odpowiedź (${helper.email}): ${cleanErr}`);
        todayStats.errorCount += 1;
        await options.store.appendLog({
          ownerUid: ownership.ownerUid,
          allowedEmails,
          level: 'error',
          category: 'imap',
          message: sanitizeForLogs(`Błąd obsługi skrzynki ${helper.email}: ${cleanErr}`),
          createdAt: new Date().toISOString(),
        });
      }
    }

    todayStats.updatedAt = new Date().toISOString();
    await options.store.saveDailyStats(todayStats);

    return {
      status: errors.length > 0 && !sent && repliedCount === 0 ? 'error' : 'completed',
      runId,
      source: options.source,
      sent,
      sentTo,
      usedFallback,
      checkedHelpers,
      repliedCount,
      rescuedFromSpamCount,
      skippedReason,
      errors,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await options.store.releaseLock(LOCK_DOC_ID, runId);
  }
}
