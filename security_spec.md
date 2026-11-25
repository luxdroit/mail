# Firestore Security Specification — MailPulse Warm-up Console

## 1. Data Invariants
1. **Default Deny**: Any unmatched path (`/databases/{database}/documents/{document=**}`) denies all reads and writes.
2. **Verified Google Identity Required**: Every read and write requires `request.auth != null && request.auth.token.email_verified == true`.
3. **Single-Owner Root Claim Lock + Isolated Personal Workspaces**:
   - `/system/ownership` can only be created once when it does not yet exist, and only with `ownerUid == request.auth.uid` and `ownerEmail == request.auth.token.email`. `ownerUid`, `ownerEmail`, and `createdAt` are immutable after creation.
   - Only the root `ownerUid` or a verified email in `coOwnerEmails` (bounded `<= 10`) can read or operate on root workspace data. Non-owners are denied even on `get` of `/system/ownership` once claimed.
   - Every other verified Google user is automatically routed to their strictly isolated personal workspace at `/users/{userId}/...`, where all reads and writes enforce `request.auth.uid == userId` and `ownerUid == userId`.
4. **Auto-Generated Runtime Keys Protection**: `/runtime_secrets/{secretId}` and `/users/{userId}/runtime_secrets/{secretId}` forbid `list` and `delete`, require strict hex/token formats (`encryptionKey` 64 hex chars, `cronSecret` 32–128 URL-safe chars), and enforce `encryptionKey` immutability on update (only `cronSecret` and `updatedAt` may be rotated).
5. **Encrypted Mailbox Secret Isolation**: `/mailbox_secrets/{mailboxId}` and `/users/{userId}/mailbox_secrets/{mailboxId}` forbid `list` completely, allow `get/write` strictly for the workspace owner/co-owner by validated ID, and enforce the AES-256-GCM ciphertext regex `^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$` (blocking plaintext passwords).
6. **Zero Ghost Fields & Bounded Strings**: Every entity validates exact allowed keys (`hasAll` + `hasOnly`), field types, string `.size()` bounds, integer ranges, and `isValidId()`.
7. **Secure List Queries**: `allow list` never invokes `get()`/`exists()` and strictly evaluates `resource.data.ownerUid == request.auth.uid` (or bounded `allowedEmails` on root workspace).
8. **Immutable Ownership**: `ownerUid` and `createdAt` cannot be altered during updates on any collection.

## 2. Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read** of `/settings/warmup` or `/users/u1/settings/warmup` (`auth: null`).
2. **Unverified email write** to `/system/ownership` or `/users/u1/system/ownership` (`email_verified: false`).
3. **Owner hijack create** on `/system/ownership` after ownership already exists by another UID.
4. **Cross-tenant workspace read/write** by User B reading `/users/userA/mailboxes/mb1` or `/users/userA/runtime_secrets/keys`.
5. **Runtime key tampering** trying to overwrite `encryptionKey` or `delete`/`list` `/runtime_secrets/keys` or `/users/u1/runtime_secrets/keys`.
6. **Ghost field injection** (`isAdmin: true`) in `/settings/warmup` update.
7. **Plaintext password write** (`encryptedPassword: "mySecretPassword123"`) to `/mailbox_secrets/mb1` (fails `v1:iv:tag:cipher` regex).
8. **List scraping** on `/mailbox_secrets`, `/runtime_secrets`, `/users/u1/mailbox_secrets`, or `/users/u1/runtime_secrets` (`allow list: if false`).
9. **Non-owner PII read** of `/system/ownership` or `/mailboxes/mb1` by an authenticated non-owner UID.
10. **Identity spoofing** setting `ownerUid: "victim-uid"` when creating `/mailboxes/mb2` or `/users/u1/mailboxes/mb2`.
11. **Path ID poisoning** creating `/mailboxes/../../admin$123` (fails `isValidId`).
12. **Oversized payload / Denial of Wallet** writing a 10KB `message` into `/logs/log1` (exceeds `size() <= 500`).
13. **Co-owner array overflow** setting 15 emails in `/system/ownership.coOwnerEmails` (exceeds `size() <= 10`).
14. **Immutable field tampering** changing `ownerUid` or `createdAt` on `/mailboxes/mb1` update.
