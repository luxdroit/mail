# Firestore Security Specification — MailPulse Warm-up Console

## 1. Data Invariants
1. **Default Deny**: Any unmatched path (`/databases/{database}/documents/{document=**}`) denies all reads and writes.
2. **Verified Google Identity Required**: Every read and write requires `request.auth != null && request.auth.token.email_verified == true`.
3. **Single-Owner Claim Lock**: `/system/ownership` can only be created once when it does not yet exist, and only with `ownerUid == request.auth.uid` and `ownerEmail == request.auth.token.email`. `ownerUid`, `ownerEmail`, and `createdAt` are immutable after creation.
4. **Co-Owner Isolation**: Only the `ownerUid` or a verified email in `coOwnerEmails` (bounded `<= 10`) can read or operate on workspace data. Non-owners are denied even on `get` of `/system/ownership` once claimed.
5. **Encrypted Secret Isolation**: `/mailbox_secrets/{mailboxId}` forbids `list` completely, allows `get/write` strictly for the owner/co-owner by validated ID, and enforces the AES-256-GCM ciphertext regex `^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$` (blocking plaintext passwords).
6. **Zero Ghost Fields & Bounded Strings**: Every entity validates exact allowed keys (`hasAll` + `hasOnly`), field types, string `.size()` bounds, integer ranges, and `isValidId()`.
7. **Secure List Queries**: `allow list` never invokes `get()`/`exists()` and strictly evaluates `resource.data.ownerUid == request.auth.uid` (or bounded `allowedEmails`).
8. **Immutable Ownership**: `ownerUid` and `createdAt` cannot be altered during updates on any collection.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read** of `/settings/warmup` (`auth: null`).
2. **Unverified email write** to `/system/ownership` (`email_verified: false`).
3. **Owner hijack create** on `/system/ownership` after ownership already exists by another UID.
4. **Ghost field injection** (`isAdmin: true`) in `/settings/warmup` update.
5. **Plaintext password write** (`encryptedPassword: "mySecretPassword123"`) to `/mailbox_secrets/mb1` (fails `v1:iv:tag:cipher` regex).
6. **List scraping** on `/mailbox_secrets` (`allow list: if false`).
7. **Non-owner PII read** of `/system/ownership` or `/mailboxes/mb1` by an authenticated non-owner UID.
8. **Identity spoofing** setting `ownerUid: "victim-uid"` when creating `/mailboxes/mb2`.
9. **Path ID poisoning** creating `/mailboxes/../../admin$123` (fails `isValidId`).
10. **Oversized payload / Denial of Wallet** writing a 10KB `message` into `/logs/log1` (exceeds `size() <= 500`).
11. **Co-owner array overflow** setting 15 emails in `/system/ownership.coOwnerEmails` (exceeds `size() <= 10`).
12. **Immutable field tampering** changing `ownerUid` or `createdAt` on `/mailboxes/mb1` update.
