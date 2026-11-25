import { useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound } from 'lucide-react';
import type { SecretsStatus } from '../../shared/types';

interface SecretsBannerProps {
  secrets: SecretsStatus;
}

function generateRandomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function SecretsBanner({ secrets }: SecretsBannerProps) {
  const [generated, setGenerated] = useState<{ encryptionKey: string; cronSecret: string } | null>(
    null
  );
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const needsEncryption = !secrets.hasEncryptionKey || !secrets.encryptionKeyValid;
  const needsCron = !secrets.hasCronSecret;

  if (!needsEncryption && !needsCron) {
    return null;
  }

  const handleGenerate = () => {
    setGenerated({
      encryptionKey: generateRandomHex(32), // 64 hex chars = 32 bytes for AES-256-GCM
      cronSecret: generateRandomHex(24),    // 48 hex chars = 192 bits entropy
    });
  };

  const handleCopy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(label);
      setTimeout(() => setCopiedField((prev) => (prev === label ? null : prev)), 2000);
    } catch {
      // Clipboard fallback ignored silently
    }
  };

  return (
    <section
      aria-label="Asystent konfiguracji Secrets"
      className="bg-amber-50 border border-amber-200 rounded-lg p-5 space-y-4"
    >
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-700" />
            <h2 className="text-sm font-semibold">
              Wymagana konfiguracja zmiennych środowiskowych serwera (.env)
            </h2>
          </div>
          <p className="text-xs text-amber-900/90 leading-relaxed max-w-3xl">
            Dodaj brakujące zmienne w pliku <strong className="font-mono">.env</strong> lub w
            ustawieniach zmiennych środowiskowych swojego hostingu (np. Docker, VPS, Railway,
            Render, Cloud Run), a następnie zrestartuj serwer. Wartości wygenerowane poniżej
            powstają lokalnie w Twojej przeglądarce (Web Crypto API) i nie są nigdzie zapisywane ani
            wysyłane.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-amber-900 pt-1">
            {needsEncryption && (
              <span>
                <strong className="font-mono">ENCRYPTION_KEY</strong>:{' '}
                {secrets.hasEncryptionKey
                  ? secrets.encryptionKeyError || 'Nieprawidłowy format (wymagane 32 bajty hex/base64)'
                  : 'Brak — wymagane do szyfrowania haseł skrzynek AES-256-GCM'}
              </span>
            )}
            {needsCron && (
              <span>
                <strong className="font-mono">CRON_SECRET</strong>: Brak — wymagane do autoryzacji{' '}
                <span className="font-mono">POST /api/cron/tick</span>
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-amber-950 bg-white border border-amber-300 rounded-md hover:bg-amber-100/70 transition-colors whitespace-nowrap shrink-0"
        >
          <KeyRound className="w-3.5 h-3.5" />
          Wygeneruj losowe wartości do skopiowania
        </button>
      </div>

      {generated && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-3 border-t border-amber-200/80">
          {needsEncryption && (
            <div className="bg-white border border-amber-200 rounded-md p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold font-mono text-slate-900">
                  ENCRYPTION_KEY (64 znaki hex / 32 bajty)
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopy('ENCRYPTION_KEY', generated.encryptionKey)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 whitespace-nowrap"
                >
                  {copiedField === 'ENCRYPTION_KEY' ? (
                    <>
                      <Check className="w-3.5 h-3.5" /> Skopiowano
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> Kopiuj
                    </>
                  )}
                </button>
              </div>
              <code
                data-testid="generated-encryption-key"
                className="block text-xs font-mono text-slate-700 break-all select-all"
              >
                {generated.encryptionKey}
              </code>
            </div>
          )}

          {needsCron && (
            <div className="bg-white border border-amber-200 rounded-md p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold font-mono text-slate-900">
                  CRON_SECRET (token dla cron-job.org)
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopy('CRON_SECRET', generated.cronSecret)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 whitespace-nowrap"
                >
                  {copiedField === 'CRON_SECRET' ? (
                    <>
                      <Check className="w-3.5 h-3.5" /> Skopiowano
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> Kopiuj
                    </>
                  )}
                </button>
              </div>
              <code
                data-testid="generated-cron-secret"
                className="block text-xs font-mono text-slate-700 break-all select-all"
              >
                {generated.cronSecret}
              </code>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
