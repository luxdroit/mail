import { useState } from 'react';
import { Check, Clock, Copy, Shield } from 'lucide-react';
import type { ExecutionLock, SecretsStatus } from '../../shared/types';

interface CronConfigViewProps {
  appUrl: string;
  secrets: SecretsStatus;
  activeLock: ExecutionLock | null;
}

export function CronConfigView({ appUrl, secrets, activeLock }: CronConfigViewProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const normalizedUrl = appUrl.replace(/\/+$/, '');
  const cronEndpoint = `${normalizedUrl}/api/cron/tick`;
  const authHeaderValue = 'Bearer <CRON_SECRET>';
  const curlSnippet = `curl -X POST "${cronEndpoint}" \\\n  -H "Authorization: Bearer $CRON_SECRET"`;

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Clipboard fallback ignored
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
              minut.
            </p>
          </div>
          <span
            className={`text-xs font-medium ${
              secrets.hasCronSecret ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {secrets.hasCronSecret ? 'CRON_SECRET skonfigurowany' : 'Brak CRON_SECRET w .env'}
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
              <button
                type="button"
                onClick={() => void copyText('headerVal', authHeaderValue)}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900"
              >
                {copiedKey === 'headerVal' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                Kopiuj
              </button>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-md font-mono text-xs text-slate-900 select-all">
              {authHeaderValue}
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-500">
          Alternatywnie endpoint akceptuje nagłówek <span className="font-mono">x-cron-secret: &lt;CRON_SECRET&gt;</span>.
          Zastąp <span className="font-mono">&lt;CRON_SECRET&gt;</span> wartością ustawioną w zmiennych środowiskowych serwera (<span className="font-mono">.env</span>).
        </p>

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
              onClick={() => void copyText('curl', curlSnippet)}
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
            {curlSnippet}
          </pre>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-2.5 text-xs text-slate-600 leading-relaxed">
        <h3 className="text-sm font-semibold text-slate-900">
          Samodzielny hosting i bezobsługowy Cron (VPS, Docker, Railway, Render, Cloud Run)
        </h3>
        <p>
          Na własnym serwerze (Docker, VPS, Railway, Render, Fly.io) dodaj w zmiennych środowiskowych
          pliku <span className="font-mono text-slate-900">.env</span> klucz konta serwisowego
          Firebase jako <span className="font-mono text-slate-900">FIREBASE_SERVICE_ACCOUNT_JSON</span>{' '}
          (lub ścieżkę <span className="font-mono text-slate-900">GOOGLE_APPLICATION_CREDENTIALS</span>).
          Dzięki temu <span className="font-mono">POST /api/cron/tick</span> działa całkowicie
          niezależnie na dowolnym hostingu.
        </p>
        <p>
          Przy wdrożeniu na Google Cloud Run wystarczy nadać kontu serwisowemu usługi rolę{' '}
          <span className="font-mono text-slate-900">roles/datastore.user</span> w IAM.
        </p>
      </section>
    </div>
  );
}
