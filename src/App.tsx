import { useCallback, useEffect, useState } from 'react';
import {
  CalendarClock,
  Clock,
  Inbox,
  LogOut,
  Mail,
  MailCheck,
  Menu,
  Play,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  AiTestResult,
  DashboardPayload,
  MailboxInput,
  MailboxPublic,
  MailboxTestResult,
  SessionResponse,
  WarmupCycleResult,
  WarmupSettings,
} from '../shared/types';
import { apiClient, ApiError } from './lib/api';
import {
  firebaseAuthAdapter,
  type AuthAdapter,
  type AuthUserLike,
} from './lib/firebase';
import { LoginScreen } from './components/LoginScreen';
import { SecretsBanner } from './components/SecretsBanner';
import { ScheduleDashboardView } from './components/ScheduleDashboardView';
import { PrimaryMailboxView } from './components/PrimaryMailboxView';
import { HelperMailboxesView } from './components/HelperMailboxesView';
import { AiAndAccessView } from './components/AiAndAccessView';
import { CronConfigView } from './components/CronConfigView';

type NavSection = 'schedule' | 'primary' | 'helpers' | 'ai' | 'cron';

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: typeof CalendarClock }> = [
  { id: 'schedule', label: 'Harmonogram i logi', icon: CalendarClock },
  { id: 'primary', label: 'Skrzynka główna', icon: Mail },
  { id: 'helpers', label: 'Skrzynki pomocnicze', icon: Inbox },
  { id: 'ai', label: 'AI i dostęp', icon: Sparkles },
  { id: 'cron', label: 'Konfiguracja Cron', icon: Clock },
];

export interface AppProps {
  authAdapter?: AuthAdapter;
}

export default function App({ authAdapter = firebaseAuthAdapter }: AppProps) {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUserLike | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);

  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [accessDeniedEmail, setAccessDeniedEmail] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState<NavSection>('schedule');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [runningCycle, setRunningCycle] = useState(false);
  const [lastCycleResult, setLastCycleResult] = useState<WarmupCycleResult | null>(null);

  const getToken = useCallback(async (): Promise<string> => {
    if (!user) throw new Error('Brak aktywnej sesji użytkownika.');
    return user.getIdToken();
  }, [user]);

  const loadDashboard = useCallback(async (u: AuthUserLike) => {
    setDashboardError(null);
    const idToken = await u.getIdToken();
    const data = await apiClient.getDashboard(idToken);
    setDashboard(data);
  }, []);

  useEffect(() => {
    const unsubscribe = authAdapter.subscribe((nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setSession(null);
        setDashboard(null);
        setAccessDeniedEmail(null);
      }
    });
    return () => unsubscribe();
  }, [authAdapter]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const bootstrap = async () => {
      setAuthLoading(true);
      setAuthError(null);
      setAccessDeniedEmail(null);
      try {
        const idToken = await user.getIdToken();
        const sess = await apiClient.initSession(idToken);
        if (cancelled) return;
        setSession(sess);
        const dash = await apiClient.getDashboard(idToken);
        if (cancelled) return;
        setDashboard(dash);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setAccessDeniedEmail(user.email || 'nieznane konto');
        } else {
          setAuthError(
            err instanceof Error ? err.message : 'Nie udało się zweryfikować sesji w serwerze.'
          );
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      await authAdapter.signInWithGoogle();
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Logowanie przez Google zostało anulowane lub nie powiodło się.'
      );
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    await authAdapter.signOut();
    setSession(null);
    setDashboard(null);
    setAccessDeniedEmail(null);
    setAuthError(null);
  };

  const handleRefresh = useCallback(async () => {
    if (!user) return;
    try {
      await loadDashboard(user);
    } catch (err) {
      setDashboardError(err instanceof Error ? err.message : 'Błąd odświeżania danych.');
    }
  }, [user, loadDashboard]);

  const handleSaveSettings = async (
    patch: Partial<WarmupSettings> & { coOwnerEmails?: string[] }
  ) => {
    const token = await getToken();
    await apiClient.updateSettings(token, patch);
    if (user) await loadDashboard(user);
  };

  const handleSavePrimary = async (input: MailboxInput): Promise<MailboxPublic> => {
    const token = await getToken();
    const res = await apiClient.createMailbox(token, { ...input, role: 'primary' });
    if (user) await loadDashboard(user);
    return res.mailbox;
  };

  const handleCreateHelper = async (input: MailboxInput): Promise<MailboxPublic> => {
    const token = await getToken();
    const res = await apiClient.createMailbox(token, { ...input, role: 'helper' });
    if (user) await loadDashboard(user);
    return res.mailbox;
  };

  const handleUpdateHelper = async (
    id: string,
    input: Partial<MailboxInput>
  ): Promise<MailboxPublic> => {
    const token = await getToken();
    const res = await apiClient.updateMailbox(token, id, input);
    if (user) await loadDashboard(user);
    return res.mailbox;
  };

  const handleDeleteHelper = async (id: string) => {
    const token = await getToken();
    await apiClient.deleteMailbox(token, id);
    if (user) await loadDashboard(user);
  };

  const handleTestMailbox = async (id: string): Promise<MailboxTestResult> => {
    const token = await getToken();
    const res = await apiClient.testMailbox(token, id);
    if (user) await loadDashboard(user);
    return res;
  };

  const handleTestAi = async (model: string): Promise<AiTestResult> => {
    const token = await getToken();
    const res = await apiClient.testAi(token, model);
    if (user) await loadDashboard(user);
    return res;
  };

  const handleRunCycleNow = async (bypassWindowAndDelay: boolean): Promise<WarmupCycleResult> => {
    setRunningCycle(true);
    setDashboardError(null);
    try {
      const token = await getToken();
      const res = await apiClient.runCycleNow(token, bypassWindowAndDelay);
      setLastCycleResult(res);
      if (user) await loadDashboard(user);
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Błąd wykonania cyklu warm-upu.';
      setDashboardError(msg);
      const fallbackErr: WarmupCycleResult = {
        status: 'error',
        runId: 'client-error',
        source: 'manual',
        sent: false,
        checkedHelpers: 0,
        repliedCount: 0,
        rescuedFromSpamCount: 0,
        errors: [msg],
        durationMs: 0,
      };
      setLastCycleResult(fallbackErr);
      return fallbackErr;
    } finally {
      setRunningCycle(false);
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Ładowanie sesji Firebase...
      </div>
    );
  }

  if (!user || accessDeniedEmail || (!session && !authLoading)) {
    return (
      <LoginScreen
        onSignIn={handleSignIn}
        loading={authLoading}
        error={authError}
        accessDeniedEmail={accessDeniedEmail}
        onSignOut={handleSignOut}
      />
    );
  }

  if (!dashboard || !session) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6 space-y-3">
          <div className="h-4 w-40 bg-slate-200 rounded animate-pulse" />
          <div className="h-3 w-full bg-slate-100 rounded animate-pulse" />
          <div className="h-3 w-3/4 bg-slate-100 rounded animate-pulse" />
          <p className="text-xs text-slate-500 pt-2">Wczytywanie konfiguracji warm-upu z Firestore...</p>
        </div>
      </div>
    );
  }

  const primaryMailbox = dashboard.mailboxes.find((m) => m.role === 'primary');
  const helperMailboxes = dashboard.mailboxes.filter((m) => m.role === 'helper');
  const currentNavLabel = NAV_ITEMS.find((i) => i.id === activeSection)?.label ?? '';

  const selectSection = (section: NavSection) => {
    setActiveSection(section);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar (256px sticky) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen bg-white border-r border-slate-200">
        <div className="h-16 px-5 flex items-center gap-2.5 border-b border-slate-200 shrink-0">
          <MailCheck className="w-5 h-5 text-blue-700 shrink-0" />
          <span className="text-sm font-bold tracking-tight text-slate-900 font-display whitespace-nowrap">
            MailPulse Warm-up
          </span>
        </div>

        <nav aria-label="Nawigacja główna" className="flex-1 overflow-y-auto p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => selectSection(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-50 text-blue-800'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="text-xs">
            <div className="font-medium text-slate-900 truncate">{session.email}</div>
            <div className="text-slate-500 mt-0.5">
              {session.isPrimaryOwner ? 'Właściciel główny' : 'Współwłaściciel'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Wyloguj się
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative z-50 w-64 max-w-[80vw] bg-white h-full flex flex-col border-r border-slate-200">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
              <span className="text-sm font-bold text-slate-900 font-display">MailPulse Warm-up</span>
              <button
                type="button"
                aria-label="Zamknij menu"
                onClick={() => setMobileNavOpen(false)}
                className="p-1.5 text-slate-600 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveSection(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-md ${
                      active ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200">
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-md"
              >
                <LogOut className="w-3.5 h-3.5" />
                Wyloguj się ({session.email})
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar (Strict 1-row contract: breadcrumb left, 1 primary action right) */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Otwórz menu nawigacji"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-md"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-500 truncate">
              <span className="hidden sm:inline">Panel Warm-up / </span>
              <span className="font-semibold text-slate-900">{currentNavLabel}</span>
            </div>
          </div>

          <button
            type="button"
            disabled={runningCycle}
            onClick={() => {
              setActiveSection('schedule');
              void handleRunCycleNow(false);
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            {runningCycle ? 'Uruchamianie...' : 'Uruchom 1 cykl teraz'}
          </button>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-6xl w-full mx-auto space-y-6">
          <SecretsBanner secrets={dashboard.secrets} />

          {dashboardError && (
            <div
              role="alert"
              className="p-3.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-800"
            >
              {dashboardError}
            </div>
          )}

          {activeSection === 'schedule' && (
            <ScheduleDashboardView
              dashboard={dashboard}
              onSaveSettings={handleSaveSettings}
              onRunCycleNow={handleRunCycleNow}
              onRefresh={handleRefresh}
              runningCycle={runningCycle}
              lastCycleResult={lastCycleResult}
            />
          )}

          {activeSection === 'primary' && (
            <PrimaryMailboxView
              primaryMailbox={primaryMailbox}
              encryptionReady={dashboard.secrets.hasEncryptionKey && dashboard.secrets.encryptionKeyValid}
              onSavePrimary={handleSavePrimary}
              onTestMailbox={handleTestMailbox}
            />
          )}

          {activeSection === 'helpers' && (
            <HelperMailboxesView
              helpers={helperMailboxes}
              encryptionReady={dashboard.secrets.hasEncryptionKey && dashboard.secrets.encryptionKeyValid}
              onCreateHelper={handleCreateHelper}
              onUpdateHelper={handleUpdateHelper}
              onDeleteHelper={handleDeleteHelper}
              onTestMailbox={handleTestMailbox}
            />
          )}

          {activeSection === 'ai' && (
            <AiAndAccessView
              settings={dashboard.settings}
              ownership={dashboard.ownership}
              isPrimaryOwner={session.isPrimaryOwner}
              secrets={dashboard.secrets}
              onSaveSettings={handleSaveSettings}
              onTestAi={handleTestAi}
            />
          )}

          {activeSection === 'cron' && (
            <CronConfigView
              appUrl={dashboard.appUrl}
              secrets={dashboard.secrets}
              activeLock={dashboard.activeLock}
            />
          )}
        </main>
      </div>
    </div>
  );
}
