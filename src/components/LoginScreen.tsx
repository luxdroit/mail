import { Lock, ShieldAlert, MailCheck } from 'lucide-react';

interface LoginScreenProps {
  onSignIn: () => Promise<void>;
  loading: boolean;
  error?: string | null;
  accessDeniedEmail?: string | null;
  onSignOut?: () => Promise<void>;
}

export function LoginScreen({
  onSignIn,
  loading,
  error,
  accessDeniedEmail,
  onSignOut,
}: LoginScreenProps) {
  if (accessDeniedEmail) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-8 space-y-6">
          <div className="flex items-center gap-3 text-red-700">
            <ShieldAlert className="w-6 h-6 shrink-0" />
            <h1 className="text-xl font-semibold text-slate-900">Dostęp zablokowany (403)</h1>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            Konto <span className="font-mono text-slate-900">{accessDeniedEmail}</span> nie znajduje
            się na liście właściciela ani współwłaścicieli tej instancji.
          </p>
          <p className="text-xs text-slate-500 leading-relaxed">
            Pierwsze konto Google, które uruchomiło aplikację, zostało trwale zapisane jako właściciel
            w Firestore. Poproś właściciela o dodanie Twojego adresu e-mail w zakładce Konfiguracja AI
            i dostęp.
          </p>
          {onSignOut && (
            <button
              type="button"
              onClick={() => void onSignOut()}
              className="w-full py-2.5 px-4 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors"
            >
              Wyloguj się i zmień konto Google
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between p-6 md:p-10">
      <header className="max-w-5xl w-full mx-auto flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <MailCheck className="w-5 h-5 text-blue-700" />
          <span className="text-base font-bold tracking-tight text-slate-900 font-display whitespace-nowrap">
            MailPulse Warm-up Console
          </span>
        </div>
        <span className="text-xs text-slate-500 whitespace-nowrap">
          SMTP / IMAP · AES-256-GCM · Cloud Run
        </span>
      </header>

      <main className="max-w-5xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 items-center my-12">
        <section className="lg:col-span-7 space-y-5">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 leading-tight">
            Kontrolowane rozgrzewanie skrzynek e-mail i ochrona dostarczalności
          </h1>
          <p className="text-base text-slate-600 leading-relaxed max-w-2xl">
            Bezstanowy silnik warm-upu działający z zewnętrznym harmonogramem cron-job.org.
            Automatycznie stopniuje dzienny wolumen, wykrywa i ratuje wiadomości ze Spamu (RFC 6154),
            prowadzi naturalne wątki B2B z Gemini API i szyfruje wszystkie hasła po stronie serwera.
          </p>

          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-6 pt-4 border-t border-slate-200">
            <div>
              <dt className="text-xs font-medium text-slate-500">Szyfrowanie haseł</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-900 font-mono">AES-256-GCM</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">Ochrona równoległości</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-900">Transakcyjny lock 2 min</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">Blokada właściciela</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-900">Pierwsze konto Google</dd>
            </div>
          </dl>
        </section>

        <section className="lg:col-span-5">
          <div className="bg-white border border-slate-200 rounded-lg p-7 space-y-5">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-slate-900">
                <Lock className="w-4 h-4 text-blue-700" />
                <h2 className="text-lg font-semibold">Logowanie do panelu</h2>
              </div>
              <p className="text-sm text-slate-600">
                Zaloguj się kontem Google. Pierwsze logowanie automatycznie przypisze Cię jako
                właściciela instancji w Firestore.
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800 leading-relaxed"
              >
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={() => void onSignIn()}
              disabled={loading}
              className="w-full py-2.5 px-4 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
            >
              {loading ? 'Łączenie z Google...' : 'Zaloguj się przez Google'}
            </button>

            <p className="text-xs text-slate-500 leading-relaxed">
              Hasła skrzynek SMTP/IMAP oraz klucze API nigdy nie trafiają do przeglądarki ani logów.
            </p>
          </div>
        </section>
      </main>

      <footer className="max-w-5xl w-full mx-auto text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-slate-200">
        <span>MailPulse Warm-up Console</span>
        <span>Firebase Auth · Firestore · Stateless Express API</span>
      </footer>
    </div>
  );
}
