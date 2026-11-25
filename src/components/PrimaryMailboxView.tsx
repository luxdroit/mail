import { useEffect, useState } from 'react';
import { CheckCircle2, PlugZap, ShieldCheck, XCircle } from 'lucide-react';
import type {
  MailboxInput,
  MailboxPublic,
  MailboxTestResult,
  SecurityMode,
} from '../../shared/types';

interface PrimaryMailboxViewProps {
  primaryMailbox: MailboxPublic | undefined;
  encryptionReady: boolean;
  onSavePrimary: (input: MailboxInput) => Promise<MailboxPublic>;
  onTestMailbox: (id: string) => Promise<MailboxTestResult>;
}

export function PrimaryMailboxView({
  primaryMailbox,
  encryptionReady,
  onSavePrimary,
  onTestMailbox,
}: PrimaryMailboxViewProps) {
  const [label, setLabel] = useState(primaryMailbox?.label ?? 'Skrzynka główna');
  const [email, setEmail] = useState(primaryMailbox?.email ?? '');
  const [password, setPassword] = useState('');
  const [securityPreset, setSecurityPreset] = useState<SecurityMode>(
    primaryMailbox?.smtpSecurity ?? 'ssl_tls'
  );
  const [smtpHost, setSmtpHost] = useState(primaryMailbox?.smtpHost ?? '');
  const [smtpPort, setSmtpPort] = useState(primaryMailbox?.smtpPort ?? 465);
  const [imapHost, setImapHost] = useState(primaryMailbox?.imapHost ?? '');
  const [imapPort, setImapPort] = useState(primaryMailbox?.imapPort ?? 993);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<MailboxTestResult | null>(null);

  useEffect(() => {
    if (primaryMailbox) {
      setLabel(primaryMailbox.label);
      setEmail(primaryMailbox.email);
      setSecurityPreset(primaryMailbox.smtpSecurity);
      setSmtpHost(primaryMailbox.smtpHost);
      setSmtpPort(primaryMailbox.smtpPort);
      setImapHost(primaryMailbox.imapHost);
      setImapPort(primaryMailbox.imapPort);
    }
  }, [primaryMailbox]);

  const applySecurityPreset = (mode: SecurityMode) => {
    setSecurityPreset(mode);
    if (mode === 'ssl_tls') {
      setSmtpPort(465);
      setImapPort(993);
    } else {
      setSmtpPort(587);
      setImapPort(143);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await onSavePrimary({
        role: 'primary',
        label: label.trim() || 'Skrzynka główna',
        email: email.trim(),
        password: password.length > 0 ? password : undefined,
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort),
        smtpSecurity: securityPreset,
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort),
        imapSecurity: securityPreset,
        active: true,
      });
      setPassword('');
      setFeedback({
        type: 'ok',
        text: 'Zapisano konfigurację skrzynki głównej. Hasło zostało zaszyfrowane po stronie serwera (AES-256-GCM).',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się zapisać skrzynki głównej.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!primaryMailbox) return;
    setTesting(true);
    setTestResult(null);
    setFeedback(null);
    try {
      const res = await onTestMailbox(primaryMailbox.id);
      setTestResult(res);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Test połączenia nie powiódł się.',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <form
        onSubmit={handleSubmit}
        className="bg-white border border-slate-200 rounded-lg p-6 space-y-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Skrzynka główna (rozgrzewana)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Z tej skrzynki silnik wysyła wiadomości do skrzynek pomocniczych i buduje jej
              reputację nadawcy.
            </p>
          </div>
          {primaryMailbox?.hasPassword && (
            <div className="inline-flex items-center gap-1.5 text-xs text-emerald-700 font-medium">
              <ShieldCheck className="w-4 h-4" />
              <span>Hasło zapisane i zaszyfrowane</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Nazwa robocza</span>
            <input
              type="text"
              required
              maxLength={100}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="np. Sprzedaż główna"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Adres e-mail (login SMTP/IMAP)</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nadawca@twojadomena.pl"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-700">
            Hasło lub hasło aplikacji{' '}
            {primaryMailbox?.hasPassword ? '(pozostaw puste, aby zachować obecne)' : '(wymagane)'}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            required={!primaryMailbox?.hasPassword}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              primaryMailbox?.hasPassword
                ? '•••••••••••••••• (hasło zaszyfrowane po stronie serwera)'
                : 'Wklej hasło aplikacji SMTP/IMAP'
            }
            className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
          />
          <span className="block text-xs text-slate-500">
            Hasło jest szyfrowane algorytmem AES-256-GCM przed zapisem w Firestore i nigdy nie jest
            zwracane do przeglądarki.
          </span>
        </label>

        {/* Security Mode Switch */}
        <div className="space-y-2 pt-2 border-t border-slate-100">
          <span className="text-xs font-medium text-slate-700 block">
            Szyfrowanie połączenia SMTP / IMAP
          </span>
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => applySecurityPreset('ssl_tls')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                securityPreset === 'ssl_tls'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              SSL/TLS (porty 465 / 993)
            </button>
            <button
              type="button"
              onClick={() => applySecurityPreset('starttls')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                securityPreset === 'starttls'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              STARTTLS (porty 587 / 143)
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <label className="sm:col-span-8 block space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Host SMTP</span>
            <input
              type="text"
              required
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="smtp.gmail.com lub mail.twojadomena.pl"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </label>
          <label className="sm:col-span-4 block space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Port SMTP</span>
            <input
              type="number"
              required
              min={1}
              max={65535}
              value={smtpPort}
              onChange={(e) => setSmtpPort(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </label>

          <label className="sm:col-span-8 block space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Host IMAP</span>
            <input
              type="text"
              required
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              placeholder="imap.gmail.com lub mail.twojadomena.pl"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </label>
          <label className="sm:col-span-4 block space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Port IMAP</span>
            <input
              type="number"
              required
              min={1}
              max={65535}
              value={imapPort}
              onChange={(e) => setImapPort(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </label>
        </div>

        {!encryptionReady && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
            Uwaga: najpierw ustaw poprawny 32-bajtowy <span className="font-mono">ENCRYPTION_KEY</span> w
            zmiennych środowiskowych serwera (<span className="font-mono">.env</span>), aby zapisać
            zaszyfrowane hasło skrzynki.
          </div>
        )}

        {feedback && (
          <div
            role="status"
            className={`p-3 rounded-md text-xs border ${
              feedback.type === 'ok'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            {feedback.text}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <button
            type="button"
            disabled={!primaryMailbox?.hasPassword || testing}
            onClick={() => void handleTest()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
          >
            <PlugZap className="w-4 h-4" />
            {testing ? 'Testowanie SMTP/IMAP...' : 'Testuj połączenie SMTP/IMAP'}
          </button>

          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
          >
            {saving ? 'Zapisywanie...' : 'Zapisz skrzynkę główną'}
          </button>
        </div>
      </form>

      {/* Live or Last Test Result */}
      {(testResult || primaryMailbox?.lastTestMessage) && (
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Wynik testu połączenia</h3>
          {testResult ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 font-medium">
                  {testResult.smtp.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-600" />
                  )}
                  <span className={testResult.smtp.ok ? 'text-emerald-800' : 'text-red-800'}>
                    SMTP ({testResult.smtp.latencyMs} ms)
                  </span>
                </div>
                <p className="text-slate-600">{testResult.smtp.message}</p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 font-medium">
                  {testResult.imap.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-600" />
                  )}
                  <span className={testResult.imap.ok ? 'text-emerald-800' : 'text-red-800'}>
                    IMAP ({testResult.imap.latencyMs} ms)
                  </span>
                </div>
                <p className="text-slate-600">{testResult.imap.message}</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-600">
              Ostatni wynik ({primaryMailbox?.lastTestStatus === 'ok' ? 'OK' : 'Błąd'}):{' '}
              {primaryMailbox?.lastTestMessage}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
