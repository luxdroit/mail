import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WarmupThread } from '../shared/types';
import { buildDomainMessageId, matchEnvelopeToPendingThread } from './mailService';

function makeThread(overrides: Partial<WarmupThread> = {}): WarmupThread {
  return {
    id: 'thr_1',
    ownerUid: 'owner-1',
    allowedEmails: ['owner@firma.pl'],
    messageId: '<abc-123@firma.pl>',
    primaryMailboxId: 'primary',
    helperMailboxId: 'helper-1',
    helperEmail: 'helper@gmail.com',
    subject: 'Krótkie pytanie o harmonogram spotkania w przyszłym tygodniu',
    bodySnippet: 'Cześć, czy wtorek przed południem pasuje?',
    format: 'plain',
    usedFallback: false,
    status: 'sent',
    foundInSpam: false,
    sentAt: '2026-11-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('mailService Message-ID and fallback thread matching', () => {
  it('buildDomainMessageId uses the sender email domain in RFC-5322 format', () => {
    const id = buildDomainMessageId('Sales@MojaFirma.PL');
    assert.match(id, /^<[0-9a-f-]+@mojafirma\.pl>$/);
  });

  it('matches pending thread by exact normalized Message-ID', () => {
    const thread = makeThread();
    const matched = matchEnvelopeToPendingThread(
      {
        uid: 42,
        messageId: '  <ABC-123@FIRMA.PL> ',
        subject: 'Different subject',
        fromAddresses: ['glowna@firma.pl'],
      },
      'glowna@firma.pl',
      [thread]
    );
    assert.equal(matched?.id, thread.id);
  });

  it('falls back to matching by primary sender + normalized subject when SMTP rewrites Message-ID', () => {
    const thread = makeThread();
    const matched = matchEnvelopeToPendingThread(
      {
        uid: 77,
        messageId: '<6745abc999@mx.google.com>',
        subject: '  Krótkie   pytanie o harmonogram spotkania w przyszłym tygodniu ',
        date: '2026-11-25T10:00:12.000Z',
        fromAddresses: ['GLOWNA@firma.pl'],
      },
      'glowna@firma.pl',
      [thread]
    );
    assert.equal(matched?.id, thread.id);
  });

  it('does not match unrelated emails from other senders or older than sentAt window', () => {
    const thread = makeThread();

    const wrongSender = matchEnvelopeToPendingThread(
      {
        uid: 80,
        messageId: '<rewritten@mx.google.com>',
        subject: thread.subject,
        date: '2026-11-25T10:01:00.000Z',
        fromAddresses: ['obcy@innafirma.pl'],
      },
      'glowna@firma.pl',
      [thread]
    );
    assert.equal(wrongSender, null);

    const tooOld = matchEnvelopeToPendingThread(
      {
        uid: 81,
        messageId: '<rewritten-old@mx.google.com>',
        subject: thread.subject,
        date: '2026-11-25T08:00:00.000Z',
        fromAddresses: ['glowna@firma.pl'],
      },
      'glowna@firma.pl',
      [thread]
    );
    assert.equal(tooOld, null);
  });
});
