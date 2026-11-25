import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSpamFolder,
  rescueMessageToInbox,
  type ImapFolderInfo,
  type MinimalImapMoveClient,
} from './spamDetector';

test('detectSpamFolder prioritizes RFC 6154 \\Junk flag over name heuristics', () => {
  const folders: ImapFolderInfo[] = [
    { path: 'INBOX', name: 'INBOX', delimiter: '.' },
    { path: 'INBOX.Spam', name: 'Spam', delimiter: '.' },
    { path: 'INBOX.CustomQuarantine', name: 'CustomQuarantine', delimiter: '.', specialUse: '\\Junk' },
  ];
  const detected = detectSpamFolder(folders);
  assert.equal(detected?.path, 'INBOX.CustomQuarantine');
});

test('detectSpamFolder handles flags Set with \\Junk', () => {
  const folders: ImapFolderInfo[] = [
    { path: 'INBOX', flags: new Set(['\\HasNoChildren']) },
    { path: '[Gmail]/Kosz', flags: new Set(['\\Trash']) },
    { path: '[Gmail]/Wiadomosci-Smieci', flags: new Set(['\\Junk', '\\HasNoChildren']) },
  ];
  assert.equal(detectSpamFolder(folders)?.path, '[Gmail]/Wiadomosci-Smieci');
});

test('detectSpamFolder matches PL/EN names case-insensitively and ignores INBOX. prefix', () => {
  assert.equal(
    detectSpamFolder([
      { path: 'INBOX', delimiter: '.' },
      { path: 'INBOX.Niechciana Poczta', delimiter: '.' },
    ])?.path,
    'INBOX.Niechciana Poczta'
  );

  assert.equal(
    detectSpamFolder([
      { path: 'INBOX', delimiter: '/' },
      { path: 'INBOX/JUNK E-MAIL', delimiter: '/' },
    ])?.path,
    'INBOX/JUNK E-MAIL'
  );

  assert.equal(
    detectSpamFolder([
      { path: 'INBOX', delimiter: '.' },
      { path: 'SPAM', delimiter: '.' },
    ])?.path,
    'SPAM'
  );
});

test('detectSpamFolder returns null cleanly when no Spam folder exists', () => {
  const folders: ImapFolderInfo[] = [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Sent', specialUse: '\\Sent' },
    { path: 'Archive', specialUse: '\\Archive' },
  ];
  assert.equal(detectSpamFolder(folders), null);
});

test('rescueMessageToInbox uses MOVE when server advertises MOVE capability', async () => {
  const calls: string[] = [];
  const client: MinimalImapMoveClient = {
    capabilities: new Set(['IMAP4rev1', 'MOVE']),
    async messageMove(uid, dest) {
      calls.push(`move:${uid}:${dest}`);
    },
    async messageCopy() {
      calls.push('copy');
    },
    async messageFlagsAdd() {
      calls.push('flags');
    },
    async messageDelete() {
      calls.push('delete');
    },
  };

  const method = await rescueMessageToInbox(client, 42);
  assert.equal(method, 'moved');
  assert.deepEqual(calls, ['move:42:INBOX']);
});

test('rescueMessageToInbox falls back to COPY + \\Deleted + EXPUNGE when MOVE is unsupported', async () => {
  const calls: string[] = [];
  const client: MinimalImapMoveClient = {
    capabilities: new Set(['IMAP4rev1', 'UIDPLUS']), // No MOVE
    async messageMove() {
      calls.push('move');
    },
    async messageCopy(uid, dest) {
      calls.push(`copy:${uid}:${dest}`);
    },
    async messageFlagsAdd(uid, flags) {
      calls.push(`flags:${uid}:${flags.join(',')}`);
    },
    async messageDelete(uid) {
      calls.push(`delete:${uid}`);
    },
  };

  const method = await rescueMessageToInbox(client, 77);
  assert.equal(method, 'copied_and_expunged');
  assert.deepEqual(calls, ['copy:77:INBOX', 'flags:77:\\Deleted', 'delete:77']);
});

test('rescueMessageToInbox falls back gracefully when MOVE throws unsupported command error', async () => {
  const calls: string[] = [];
  const client: MinimalImapMoveClient = {
    capabilities: new Map([['MOVE', true]]),
    async messageMove() {
      calls.push('move-attempt');
      throw new Error('BAD Unknown command MOVE');
    },
    async messageCopy(uid, dest) {
      calls.push(`copy:${uid}:${dest}`);
    },
    async messageFlagsAdd(uid, flags) {
      calls.push(`flags:${uid}:${flags.join(',')}`);
    },
    async messageDelete(uid) {
      calls.push(`delete:${uid}`);
    },
  };

  const method = await rescueMessageToInbox(client, 19);
  assert.equal(method, 'copied_and_expunged');
  assert.deepEqual(calls, ['move-attempt', 'copy:19:INBOX', 'flags:19:\\Deleted', 'delete:19']);
});
