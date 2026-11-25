import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import bundledFirebaseConfig from '../../firebase-applet-config.json';

const hasCustomFirebaseEnv = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY && import.meta.env.VITE_FIREBASE_PROJECT_ID
);

const firebaseConfig = hasCustomFirebaseEnv
  ? {
      apiKey: String(import.meta.env.VITE_FIREBASE_API_KEY),
      authDomain: String(
        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ||
          `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`
      ),
      projectId: String(import.meta.env.VITE_FIREBASE_PROJECT_ID),
      appId: String(import.meta.env.VITE_FIREBASE_APP_ID || ''),
    }
  : bundledFirebaseConfig;

const firestoreDatabaseId = hasCustomFirebaseEnv
  ? String(import.meta.env.VITE_FIREBASE_DATABASE_ID || '(default)')
  : bundledFirebaseConfig.firestoreDatabaseId;

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testConnection();

export interface AuthUserLike {
  uid: string;
  email: string | null;
  displayName: string | null;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
}

export interface AuthAdapter {
  subscribe: (cb: (user: AuthUserLike | null) => void) => () => void;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const firebaseAuthAdapter: AuthAdapter = {
  subscribe(cb) {
    return onAuthStateChanged(auth, (user: User | null) => {
      if (!user) {
        cb(null);
        return;
      }
      cb({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        getIdToken: (forceRefresh?: boolean) => user.getIdToken(forceRefresh),
      });
    });
  },
  async signInWithGoogle() {
    await signInWithPopup(auth, googleProvider);
  },
  async signOut() {
    await signOut(auth);
  },
};
