import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { SecretsStatus } from '../shared/types';
import { safeCompareSecret, validateEncryptionKeyStatus } from './crypto';
import { loadFirebaseAppletConfig } from './firestoreStore';

export interface VerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
}

export type TokenVerifier = (idToken: string) => Promise<VerifiedUser>;

/**
 * Verifies Firebase Auth ID tokens using firebase-admin/auth initialized ONLY with projectId.
 * Per Firebase Admin SDK guidance, verifyIdToken(token) requires NO IAM permissions and works on all projects.
 */
export function createFirebaseTokenVerifier(): TokenVerifier {
  return async (idToken: string): Promise<VerifiedUser> => {
    const cfg = loadFirebaseAppletConfig();
    const app = getApps().length ? getApp() : initializeApp({ projectId: cfg.projectId });
    const decoded = await getAuth(app).verifyIdToken(idToken);
    if (!decoded.email || decoded.email_verified !== true) {
      throw new Error('Konto Google wymaga zweryfikowanego adresu e-mail.');
    }
    return {
      uid: decoded.uid,
      email: decoded.email.toLowerCase(),
      emailVerified: true,
      idToken,
    };
  };
}

export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

export function verifyCronAuthorization(
  headers: { authorization?: string; 'x-cron-secret'?: string | string[] },
  expectedSecret?: string
): { ok: boolean; status: number; error?: string } {
  const configured = (expectedSecret ?? process.env.CRON_SECRET ?? '').trim();
  if (!configured) {
    return {
      ok: false,
      status: 503,
      error: 'CRON_SECRET nie jest ustawiony w zmiennych środowiskowych serwera (.env).',
    };
  }

  const bearer = extractBearerToken(headers.authorization);
  const rawHeader = headers['x-cron-secret'];
  const xCron = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const provided = bearer || (xCron ? xCron.trim() : '');

  if (!provided || !safeCompareSecret(provided, configured)) {
    return {
      ok: false,
      status: 401,
      error: 'Nieprawidłowy lub brakujący nagłówek autoryzacji Cron (Authorization: Bearer <CRON_SECRET>).',
    };
  }

  return { ok: true, status: 200 };
}

export function getSecretsStatus(env: NodeJS.ProcessEnv = process.env): SecretsStatus {
  const enc = validateEncryptionKeyStatus(env.ENCRYPTION_KEY);
  const cronSecret = (env.CRON_SECRET ?? '').trim();
  const geminiKey = (env.GEMINI_API_KEY ?? '').trim();

  return {
    hasEncryptionKey: enc.present,
    encryptionKeyValid: enc.valid,
    encryptionKeyError: enc.error,
    hasCronSecret: cronSecret.length >= 16,
    hasGeminiKey: Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY'),
  };
}
