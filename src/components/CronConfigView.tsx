import { useState } from 'react';
import { Check, Clock, Copy, Eye, EyeOff, RefreshCw, Shield } from 'lucide-react';
import type { ExecutionLock, SecretsStatus } from '../../shared/types';

interface CronConfigViewProps {
  appUrl: string;
  workspaceId: string;
  isPersonalWorkspace: boolean;
  cronToken?: string;
  secrets: SecretsStatus;
  activeLock: ExecutionLock | null;
  onRotateCronSecret: () => Promise<string>;
}

function maskToken(token: string): string {
  if (token.length <= 8) return '••••••••';
  return `${'•'.repeat(16)}${token.slice(-6)}`;
}

export function CronConfigView({
  appUrl,
  workspaceId,
  isPersonalWorkspace,
  cronToken,
  secrets,
  activeLock,
  onRotateCronSecret,
}: CronConfigViewProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateStatus, setRotateStatus] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const normalizedUrl = appUrl.replace(/\/+$/, '');
  const cronEndpoint = isPersonalWorkspace
    ? `${normalizedUrl}/api/cron/tick?workspace=${encodeURIComponent(workspaceId)}`
    : `${normalizedUrl}/api/cron/tick`;

  const isAutoManaged = secrets.cronSecretSource === 'auto' && Boolean(cronToken);
  const authHeaderCopyValue = isAutoManaged && cronToken ? `Bearer ${cronToken}` : 'Bearer <CRON_SECRET>';
  const authHeaderDisplayValue =
    isAutoManaged && cronToken
      ? revealed
        ? `Bearer ${cronToken}`
        : `Bearer ${maskToken(cronToken)}`
      : 'Bearer <CRON_SECRET>';

  const curlCopySnippet =
    isAutoManaged && cronToken
      ? `curl -X POST "${cronEndpoint}" \\\n  -H "Authorization: Bearer ${cronToken}"`
      : `curl -X POST "${cronEndpoint}" \\\n  -H "Authorization: Bearer $CRON_SECRET"`;

  const curlDisplaySnippet =
    isAutoManaged && cronToken
      ? `curl -X POST "${cronEndpoint}" \\\n  -H "Authorization: Bearer ${revealed ? cronToken : maskToken(cronToken)}"`
      : curlCopySnippet;

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleRotate = async () => {
    setRotating(true);
    setRotateStatus(null);
    try {
      await onRotateCronSecret();
      setRevealed(true);
      setRotateStatus({
        type: 'ok',
        text: 'Wygenerowano nowy token Cron. Zaktualizuj nagłówek Authorization w cron-job.org.',
      });
    } catch (err) {
      setRotateStatus({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się wygenerować nowego tokenu Cron.',
      });
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Konfiguracja zewnętrznego Crona (cron-job.org)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Aplikacja nie używa pętli setInterval w pamięci — wywołuj poniższy endpoint co 10–15
              minut. Token autoryzacji został wygenerowany automatycznie dla Twojego konta.
            </p>
          </div>
          <span
            className={`text-xs font-medium ${
              secrets.hasCronSecret ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {secrets.cronSecretSource === 'auto'
              ? 'Automatyczny token Cron aktywny'
              : secrets.cronSecretSource === 'env'
                ? 'CRON_SECRET z pliku .env aktywny'
                : 'Brak tokenu Cron'}
          </span>
        </div>

        {/* Endpoint URL */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700">Metoda i adres URL żądania</span>
            <button
              type="button"
              onClick={() => void copyText('url', cronEndpoint)}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900"
            >
              {copiedKey === 'url' ? (
                <>
                  <Check className="w-3.5 h-3.5" /> Skopiowano URL
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" /> Kopiuj URL
                </>
              )}
            </button>
          </div>
          <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-md font-mono text-xs text-slate-900 overflow-x-auto">
            <span className="font-semibold text-blue-700 shrink-0">POST</span>
            <code data-testid="cron-endpoint-url" className="select-all">
              {cronEndpoint}
            </code>
          </div>
        </div>

        {/* Authorization Header */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">Nazwa nagłówka HTTP</span>
              <button
                type="button"
                onClick={() => void copyText('headerName', 'Authorization')}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900"
              >
                {copiedKey === 'headerName' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                Kopiuj
              </button>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-md font-mono text-xs text-slate-900 select-all">
              Authorization
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">Wartość nagłówka</span>
              <div className="flex items-center gap-3">
                {isAutoManaged && (
                  <button
                    type="button"
                    onClick={() => setRevealed((prev) => !prev)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
                  >
                    {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    {revealed ? 'Ukryj' : 'Pokaż'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void copyText('headerVal', authHeaderCopyValue)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900"
                >
                  {copiedKey === 'headerVal' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedKey === 'headerVal' ? 'Skopiowano' : 'Kopiuj'}
                </button>
              </div>
            </div>
            <div
              data-testid="cron-auth-header"
              className="p-3 bg-slate-50 border border-slate-200 rounded-md font-mono text-xs text-slate-900 overflow-x-auto whitespace-nowrap"
            >
              {authHeaderDisplayValue}
            </div>
          </div>
        </div>

        {isAutoManaged && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="text-xs text-slate-500">
              Token jest przypisany wyłącznie do Twojej przestrzeni roboczej — nie trzeba ręcznie
              ustawiać zmiennej <span className="font-mono">CRON_SECRET</span>.
            </p>
            <button
              type="button"
              disabled={rotating}
              onClick={() => void handleRotate()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${rotating ? 'animate-spin' : ''}`} />
              {rotating ? 'Generowanie...' : 'Wygeneruj nowy token'}
            </button>
          </div>
        )}

        {!isAutoManaged && (
          <p className="text-xs text-slate-500">
            Alternatywnie endpoint akceptuje nagłówek <span className="font-mono">x-cron-secret: &lt;CRON_SECRET&gt;</span>.
            Zastąp <span className="font-mono">&lt;CRON_SECRET&gt;</span> wartością ustawioną w zmiennych środowiskowych serwera (<span className="font-mono">.env</span>).
          </p>
        )}

        {rotateStatus && (
          <div
            role="status"
            className={`p-3 rounded-md text-xs border ${
              rotateStatus.type === 'ok'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            {rotateStatus.text}
          </div>
        )}

        {/* Suggested Interval & Lock */}
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-100 text-xs">
          <div className="space-y-1">
            <dt className="text-slate-500 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> Sugerowany interwał
            </dt>
            <dd className="font-medium text-slate-900 font-mono">Co 10–15 min (*/10 * * * *)</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-slate-500 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" /> Transakcyjny lock TTL
            </dt>
            <dd className="font-medium text-slate-900">120 s (ochrona przed kolizją)</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-slate-500">Aktualny stan locka</dt>
            <dd className="font-medium text-slate-900 font-mono">
              {activeLock ? `Zajęty (${activeLock.source})` : 'Wolny'}
            </dd>
          </div>
        </dl>

        {/* Quick cURL test snippet */}
        <div className="space-y-1.5 pt-4 border-t border-slate-100">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700">Szybki test z terminala (cURL)</span>
            <button
              type="button"
              onClick={() => void copyText('curl', curlCopySnippet)}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900"
            >
              {copiedKey === 'curl' ? (
                <>
                  <Check className="w-3.5 h-3.5" /> Skopiowano
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" /> Kopiuj cURL
                </>
              )}
            </button>
          </div>
          <pre className="p-3 bg-slate-900 text-slate-100 rounded-md font-mono text-xs overflow-x-auto leading-relaxed">
            {curlDisplaySnippet}
          </pre>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-2.5 text-xs text-slate-600 leading-relaxed">
        <h3 className="text-sm font-semibold text-slate-900">
          Bezobsługowy Cron na własnym serwerze lub w Cloud Run
        </h3>
        <p>
          Dla wywołań w tle (<span className="font-mono">POST /api/cron/tick</span>) serwer
          potrzebuje poświadczeń dostępu do Firestore: na własnym hostingu (Docker, VPS, Railway,
          Render) wystarczy dodać <span className="font-mono text-slate-900">FIREBASE_SERVICE_ACCOUNT_JSON</span>{' '}
          w <span className="font-mono text-slate-900">.env</span>, a w Cloud Run nadać kontu
          serwisowemu rolę <span className="font-mono text-slate-900">roles/datastore.user</span>.
          Wszystkie klucze szyfrowania i tokeny Cron użytkowników są już generowane automatycznie.
        </p>
      </section>
    </div>
  );
}
