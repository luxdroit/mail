export interface ImapFolderInfo {
  path: string;
  name?: string;
  delimiter?: string;
  specialUse?: string;
  flags?: Set<string> | string[];
}

export interface MinimalImapMoveClient {
  capabilities?: Set<string> | Map<string, unknown>;
  messageMove: (range: string | number, destination: string, options?: { uid?: boolean }) => Promise<unknown>;
  messageCopy: (range: string | number, destination: string, options?: { uid?: boolean }) => Promise<unknown>;
  messageFlagsAdd: (range: string | number, flags: string[], options?: { uid?: boolean }) => Promise<unknown>;
  messageDelete: (range: string | number, options?: { uid?: boolean }) => Promise<unknown>;
}

const KNOWN_SPAM_NAMES = new Set([
  'spam',
  'junk',
  'junk mail',
  'junk email',
  'junk e-mail',
  'bulk',
  'bulk mail',
  'bulk email',
  'niechciana',
  'niechciana poczta',
  'poczta niechciana',
  'wiadomości-śmieci',
  'wiadomosci-smieci',
  'wiadomości śmieci',
  'wiadomosci smieci',
  'śmieci',
  'smieci',
  '[gmail]/spam',
  '[google mail]/spam',
  'unsolicited',
]);

export function normalizeFolderName(rawPath: string, delimiter?: string): {
  strippedFull: string;
  leaf: string;
} {
  const trimmed = rawPath.trim();
  const sep = delimiter && delimiter.length > 0 ? delimiter : '.';

  // Strip case-insensitive INBOX. or INBOX/ prefix
  const withoutInboxPrefix = trimmed
    .replace(/^inbox[./]/i, '')
    .trim()
    .toLowerCase();

  // Extract the last path segment using either explicit delimiter or common separators
  const parts = withoutInboxPrefix.split(new RegExp(`[${sep === '.' ? '\\.' : sep}/\\\\]`));
  const leaf = (parts[parts.length - 1] ?? withoutInboxPrefix).trim().toLowerCase();

  return {
    strippedFull: withoutInboxPrefix,
    leaf,
  };
}

function hasJunkFlag(folder: ImapFolderInfo): boolean {
  if (folder.specialUse && folder.specialUse.toLowerCase() === '\\junk') {
    return true;
  }
  if (!folder.flags) return false;
  const iterable = folder.flags instanceof Set ? Array.from(folder.flags) : folder.flags;
  return iterable.some((flag) => String(flag).toLowerCase() === '\\junk');
}

/**
 * Detects the Spam/Junk folder in an IMAP mailbox list:
 * 1. Priority 1: RFC 6154 `\Junk` special-use flag.
 * 2. Priority 2: Common PL/EN folder names (case-insensitive, ignoring `INBOX.` / `INBOX/` prefix).
 * Returns null if no Spam folder exists on the server.
 */
export function detectSpamFolder(folders: ImapFolderInfo[]): ImapFolderInfo | null {
  if (!Array.isArray(folders) || folders.length === 0) return null;

  // Priority 1: RFC 6154 \Junk
  const byFlag = folders.find((f) => hasJunkFlag(f));
  if (byFlag) return byFlag;

  // Priority 2: Common PL/EN names
  for (const folder of folders) {
    const { strippedFull, leaf } = normalizeFolderName(folder.path, folder.delimiter);
    const nameNorm = folder.name ? folder.name.trim().toLowerCase() : '';
    if (
      KNOWN_SPAM_NAMES.has(strippedFull) ||
      KNOWN_SPAM_NAMES.has(leaf) ||
      (nameNorm && KNOWN_SPAM_NAMES.has(nameNorm))
    ) {
      return folder;
    }
  }

  return null;
}

export function clientSupportsMove(client: MinimalImapMoveClient): boolean {
  const caps = client.capabilities;
  if (!caps) return false;
  if (caps instanceof Set) {
    for (const key of caps) {
      if (String(key).toUpperCase() === 'MOVE') return true;
    }
    return false;
  }
  if (caps instanceof Map) {
    for (const key of caps.keys()) {
      if (String(key).toUpperCase() === 'MOVE') return true;
    }
    return false;
  }
  return false;
}

/**
 * Moves a message from Spam to INBOX.
 * Uses IMAP MOVE when supported; gracefully falls back to COPY + \Deleted + EXPUNGE (messageDelete)
 * when the server lacks MOVE capability or rejects the MOVE command.
 */
export async function rescueMessageToInbox(
  client: MinimalImapMoveClient,
  uid: number
): Promise<'moved' | 'copied_and_expunged'> {
  if (clientSupportsMove(client)) {
    try {
      await client.messageMove(uid, 'INBOX', { uid: true });
      return 'moved';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fallback on servers that advertise or fail MOVE unexpectedly
      const isMoveUnsupported =
        /move|unsupported|command|unknown|bad/i.test(msg);
      if (!isMoveUnsupported) {
        throw err;
      }
    }
  }

  await client.messageCopy(uid, 'INBOX', { uid: true });
  await client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
  await client.messageDelete(uid, { uid: true });
  return 'copied_and_expunged';
}
