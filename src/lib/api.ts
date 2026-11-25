import type {
  AiTestResult,
  DashboardPayload,
  MailboxInput,
  MailboxPublic,
  MailboxTestResult,
  OwnershipDoc,
  SessionResponse,
  WarmupCycleResult,
  WarmupSettings,
} from '../../shared/types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function apiFetch<T>(
  path: string,
  idToken: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text };
  }

  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : null) || `Błąd serwera (HTTP ${res.status}).`;
    throw new ApiError(res.status, msg);
  }

  return parsed as T;
}

export const apiClient = {
  initSession(idToken: string): Promise<SessionResponse> {
    return apiFetch<SessionResponse>('/api/auth/session', idToken, { method: 'POST' });
  },

  getDashboard(idToken: string): Promise<DashboardPayload> {
    return apiFetch<DashboardPayload>('/api/dashboard', idToken, { method: 'GET' });
  },

  updateSettings(
    idToken: string,
    patch: Partial<WarmupSettings> & { coOwnerEmails?: string[] }
  ): Promise<{ settings: WarmupSettings; ownership: OwnershipDoc }> {
    return apiFetch<{ settings: WarmupSettings; ownership: OwnershipDoc }>(
      '/api/settings',
      idToken,
      {
        method: 'PUT',
        body: JSON.stringify(patch),
      }
    );
  },

  testAi(idToken: string, model?: string): Promise<AiTestResult> {
    return apiFetch<AiTestResult>('/api/ai/test', idToken, {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
  },

  createMailbox(idToken: string, input: MailboxInput): Promise<{ mailbox: MailboxPublic }> {
    return apiFetch<{ mailbox: MailboxPublic }>('/api/mailboxes', idToken, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  updateMailbox(
    idToken: string,
    id: string,
    input: Partial<MailboxInput>
  ): Promise<{ mailbox: MailboxPublic }> {
    return apiFetch<{ mailbox: MailboxPublic }>(`/api/mailboxes/${encodeURIComponent(id)}`, idToken, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  deleteMailbox(idToken: string, id: string): Promise<{ deleted: boolean; id: string }> {
    return apiFetch<{ deleted: boolean; id: string }>(
      `/api/mailboxes/${encodeURIComponent(id)}`,
      idToken,
      { method: 'DELETE' }
    );
  },

  testMailbox(idToken: string, id: string): Promise<MailboxTestResult> {
    return apiFetch<MailboxTestResult>(
      `/api/mailboxes/${encodeURIComponent(id)}/test`,
      idToken,
      { method: 'POST' }
    );
  },

  runCycleNow(idToken: string, bypassWindowAndDelay: boolean): Promise<WarmupCycleResult> {
    return apiFetch<WarmupCycleResult>('/api/warmup/run-now', idToken, {
      method: 'POST',
      body: JSON.stringify({ bypassWindowAndDelay }),
    });
  },

  rotateCronSecret(idToken: string): Promise<{ cronToken: string }> {
    return apiFetch<{ cronToken: string }>('/api/cron/rotate-secret', idToken, {
      method: 'POST',
    });
  },
};
