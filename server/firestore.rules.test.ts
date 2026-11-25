import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesContent = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');

test('firestore.rules enforces default-deny catch-all and rules_version 2', () => {
  assert.match(rulesContent, /rules_version\s*=\s*'2'/);
  assert.match(rulesContent, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
});

test('firestore.rules enforces verified email and blocks mailbox_secrets list and plaintext writes', () => {
  assert.match(rulesContent, /request\.auth\.token\.email_verified == true/);
  assert.match(rulesContent, /match \/mailbox_secrets\/\{mailboxId\}[\s\S]*?allow list: if false;/);
  assert.match(rulesContent, /\^v1:\[0-9a-f\]\+:\[0-9a-f\]\+:\[0-9a-f\]\+\$/);
});

test('firestore.rules secures runtime_secrets with immutable encryptionKey and blocks list/delete', () => {
  assert.match(rulesContent, /match \/runtime_secrets\/\{secretId\}[\s\S]*?allow list: if false;[\s\S]*?allow delete: if false;/);
  assert.match(rulesContent, /incoming\(\)\.encryptionKey == existing\(\)\.encryptionKey/);
  assert.match(rulesContent, /match \/users\/\{userId\}\/runtime_secrets\/\{secretId\}[\s\S]*?allow list: if false;[\s\S]*?allow delete: if false;/);
});

test('firestore.rules secures isolated per-user workspaces by UID', () => {
  assert.match(rulesContent, /function isUserWorkspaceOwner\(userId\)[\s\S]*?request\.auth\.uid == userId/);
  assert.match(rulesContent, /match \/users\/\{userId\}\/mailboxes\/\{mailboxId\}[\s\S]*?allow list: if matchesPersonalResource\(userId\);/);
  assert.match(rulesContent, /match \/users\/\{userId\}\/mailbox_secrets\/\{mailboxId\}[\s\S]*?allow list: if false;/);
});

test('firestore.rules secures ownership claim, immutability, and query-enforced list rules', () => {
  assert.match(rulesContent, /match \/system\/ownership[\s\S]*?!ownershipExists\(\)[\s\S]*?incoming\(\)\.ownerUid == request\.auth\.uid/);
  assert.match(rulesContent, /incoming\(\)\.ownerUid == existing\(\)\.ownerUid/);
  assert.match(rulesContent, /function matchesResourceAccess\(\)[\s\S]*?resource\.data\.ownerUid == request\.auth\.uid/);
  // Ensure no blanket allow read/list: if isSignedIn()
  assert.equal(/allow\s+(read|list)\s*:\s*if\s+isSignedIn\(\)\s*;/.test(rulesContent), false);
});
