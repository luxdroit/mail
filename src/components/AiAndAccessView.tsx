import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import {
  RECOMMENDED_AI_MODELS,
  type AiTestResult,
  type OwnershipDoc,
  type SecretsStatus,
  type WarmupSettings,
} from '../../shared/types';

interface AiAndAccessViewProps {
  settings: WarmupSettings;
  ownership: OwnershipDoc;
  isPrimaryOwner: boolean;
  isPersonalWorkspace: boolean;
  secrets: SecretsStatus;
  onSaveSettings: (patch: Partial<WarmupSettings> & { coOwnerEmails?: string[]; geminiApiKey?: string }) => Promise<void>;
  onTestAi: (model: string) => Promise<AiTestResult>;
}

export function AiAndAccessView({
  settings,
  ownership,
  isPrimaryOwner,
  isPersonalWorkspace,
  secrets,
  onSaveSettings,
  onTestAi,
}: AiAndAccessViewProps) {
  const isPreset = RECOMMENDED_AI_MODELS.some((m) => m.id === settings.aiModel);
  const [selectedModel, setSelectedModel] = useState(isPreset ? settings.aiModel : '__custom__');
  const [customModel, setCustomModel] = useState(isPreset ? '' : settings.aiModel);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  const [savingAi, setSavingAi] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiResult, setAiResult] = useState<AiTestResult | null>(null);
  const [aiMessage, setAiMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const [coOwners, setCoOwners] = useState<string[]>(ownership.coOwnerEmails);
  const [newCoOwner, setNewCoOwner] = useState('');
  const [savingAccess, setSavingAccess] = useState(false);
  const [accessMessage, setAccessMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const presetMatch = RECOMMENDED_AI_MODELS.some((m) => m.id === settings.aiModel);
    setSelectedModel(presetMatch ? settings.aiModel : '__custom__');
    setCustomModel(presetMatch ? '' : settings.aiModel);
  }, [settings.aiModel]);

  useEffect(() => {
    setCoOwners(ownership.coOwnerEmails);
  }, [ownership.coOwnerEmails]);

  const effectiveModel = selectedModel === '__custom__' ? customModel.trim() : selectedModel;

  const handleSaveModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveModel) {
      setAiMessage({ type: 'error', text: 'Wpisz nazwę modelu Gemini.' });
      return;
    }
    setSavingAi(true);
    setAiMessage(null);
    try {
      const patch: Partial<WarmupSettings> & { geminiApiKey?: string } = {
        aiModel: effectiveModel,
      };
      if (apiKeyInput.trim()) {
        patch.geminiApiKey = apiKeyInput.trim();
      }
      await onSaveSettings(patch);
      setApiKeyInput('');
      setAiMessage({ type: 'ok', text: `Zapisano konfigurację AI (${effectiveModel}).` });
    } catch (err) {
      setAiMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się zapisać ustawień AI.',
      });
    } finally {
      setSavingAi(false);
    }
  };

  const handleRemoveApiKey = async () => {
    setSavingAi(true);
    setAiMessage(null);
    try {
      await onSaveSettings({ geminiApiKey: '' });
      setApiKeyInput('');
      setAiMessage({ type: 'ok', text: 'Usunięto własny klucz API. Przywrócono tryb domyślny.' });
    } catch (err) {
      setAiMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się usunąć klucza.',
      });
    } finally {
      setSavingAi(false);
    }
  };

  const handleTestAi = async () => {
    setTestingAi(true);
    setAiResult(null);
    setAiMessage(null);
    try {
      if (apiKeyInput.trim()) {
        await onSaveSettings({ geminiApiKey: apiKeyInput.trim(), aiModel: effectiveModel });
        setApiKeyInput('');
      }
      const res = await onTestAi(effectiveModel || settings.aiModel);
      setAiResult(res);
    } catch (err) {
      setAiMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Błąd testu połączenia z Gemini API.',
      });
    } finally {
      setTestingAi(false);
    }
  };

  const handleAddCoOwner = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = newCoOwner.trim().toLowerCase();
    if (!email) return;
    if (coOwners.includes(email) || email === ownership.ownerEmail.toLowerCase()) {
      setAccessMessage({ type: 'error', text: 'Ten adres ma już dostęp do panelu.' });
      return;
    }
    const next = [...coOwners, email];
    setSavingAccess(true);
    setAccessMessage(null);
    try {
      await onSaveSettings({ coOwnerEmails: next });
      setNewCoOwner('');
      setAccessMessage({ type: 'ok', text: `Dodano współwłaściciela: ${email}.` });
    } catch (err) {
      setAccessMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się dodać współwłaściciela.',
      });
    } finally {
      setSavingAccess(false);
    }
  };

  const handleRemoveCoOwner = async (email: string) => {
    const next = coOwners.filter((item) => item !== email);
    setSavingAccess(true);
    setAccessMessage(null);
    try {
      await onSaveSettings({ coOwnerEmails: next });
      setAccessMessage({ type: 'ok', text: `Odebrano dostęp kontu ${email}.` });
    } catch (err) {
      setAccessMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się usunąć współwłaściciela.',
      });
    } finally {
      setSavingAccess(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* Automatyczne klucze */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
          <KeyRound className="w-4 h-4 text-blue-700" />
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Klucze bezpieczeństwa i AI
            </h2>
            <p className="text-xs text-slate-500">
              Klucz szyfrowania haseł i token Cron są generowane automatycznie dla Twojego konta.
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-1">
            <dt className="text-slate-500">Szyfrowanie haseł (AES-256-GCM)</dt>
            <dd className="font-medium text-emerald-700">
              {secrets.encryptionKeySource === 'auto'
                ? 'Aktywne (auto-wygenerowane)'
                : secrets.encryptionKeySource === 'env' && secrets.encryptionKeyValid
                  ? 'Aktywne (ze zmiennej .env)'
                  : 'Wymaga uwagi'}
            </dd>
          </div>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-1">
            <dt className="text-slate-500">Autoryzacja Cron</dt>
            <dd className="font-medium text-emerald-700">
              {secrets.cronSecretSource === 'auto'
                ? 'Aktywna (auto-wygenerowana)'
                : secrets.cronSecretSource === 'env'
                  ? 'Aktywna (ze zmiennej .env)'
                  : 'Brak tokenu'}
            </dd>
          </div>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-1">
            <dt className="text-slate-500">Silnik treści AI (Gemini)</dt>
            <dd className={`font-medium ${settings.hasCustomAiKey || secrets.hasGeminiKey ? 'text-emerald-700' : 'text-amber-700'}`}>
              {settings.hasCustomAiKey
                ? 'Własny klucz użytkownika'
                : secrets.hasGeminiKey
                  ? 'Współdzielony klucz serwera'
                  : 'Wbudowane szablony (fallback)'}
            </dd>
          </div>
        </dl>
      </section>

      {/* Konfiguracja Gemini AI i własnego klucza */}
      <form
        onSubmit={handleSaveModel}
        className="bg-white border border-slate-200 rounded-lg p-6 space-y-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Konfiguracja Google Gemini AI</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Generowanie unikalnych maili i odpowiedzi na Twoim własnym kluczu API z Google AI Studio.
            </p>
          </div>
          <span
            className={`text-xs font-medium ${
              settings.hasCustomAiKey || secrets.hasGeminiKey ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {settings.hasCustomAiKey
              ? 'Własny klucz aktywny (AES-256)'
              : secrets.hasGeminiKey
                ? 'Klucz serwera aktywny'
                : 'Brak klucza (aktywne szablony fallback)'}
          </span>
        </div>

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Model Gemini</span>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
            >
              {RECOMMENDED_AI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value="__custom__">Własny identyfikator modelu...</option>
            </select>
          </label>

          {selectedModel === '__custom__' && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Własna nazwa modelu</span>
              <input
                type="text"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="np. gemini-3.5-flash-lite lub gemini-3.8-flash"
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
          )}

          {/* Własny klucz API */}
          <div className="space-y-1.5 pt-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-700">
                Twój klucz API Google Gemini (AI Studio)
              </label>
              {settings.hasCustomAiKey && (
                <button
                  type="button"
                  onClick={() => void handleRemoveApiKey()}
                  disabled={savingAi}
                  className="text-xs text-red-600 hover:text-red-800 transition-colors"
                >
                  Usuń zapisany klucz
                </button>
              )}
            </div>

            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={
                  settings.hasCustomAiKey
                    ? '•••••••••••••••••••••••••••••••••••• (Klucz zapisany — wpisz nowy, aby podmienić)'
                    : 'Wklej klucz (np. AIzaSy...)'
                }
                className="w-full pr-10 px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Klucz uzyskasz na <strong>aistudio.google.com</strong>. Jest on szyfrowany i zapisywany w Twoim profilu.
            </p>
          </div>
        </div>

        {aiMessage && (
          <div
            role="status"
            className={`p-3 rounded-md text-xs border ${
              aiMessage.type === 'ok'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            {aiMessage.text}
          </div>
        )}

        {aiResult && (
          <div
            className={`p-4 rounded-md text-xs border space-y-1.5 ${
              aiResult.ok
                ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
                : 'bg-amber-50 border-amber-200 text-amber-950'
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-medium">
              <span className="inline-flex items-center gap-1.5">
                {aiResult.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-700" />
                )}
                {aiResult.ok ? 'Gemini API połączone' : 'Aktywny tryb fallback'}
              </span>
              <span className="font-mono tabular-nums">{aiResult.latencyMs} ms</span>
            </div>
            <p>{aiResult.message}</p>
            {aiResult.sampleSubject && (
              <p className="text-slate-700 pt-1">
                Przykładowy wygenerowany temat: <span className="font-medium">{aiResult.sampleSubject}</span>
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <button
            type="button"
            disabled={testingAi}
            onClick={() => void handleTestAi()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
          >
            <Sparkles className="w-4 h-4" />
            {testingAi ? 'Testowanie Gemini...' : 'Testuj połączenie'}
          </button>

          <button
            type="submit"
            disabled={savingAi}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
          >
            {savingAi ? 'Zapisywanie...' : 'Zapisz ustawienia AI'}
          </button>
        </div>
      </form>

      {/* Dostęp do przestrzeni roboczej */}
      {isPersonalWorkspace ? (
        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100">
            <Users className="w-4 h-4 text-slate-700" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Twoja prywatna przestrzeń robocza
              </h2>
              <p className="text-xs text-slate-500">
                Wszystkie Twoje skrzynki, hasła, klucz AI, harmonogram i token Cron są w pełni
                odizolowane od innych użytkowników.
              </p>
            </div>
          </div>
          <div className="text-xs space-y-1">
            <span className="text-slate-500">Zalogowane konto Google:</span>
            <div className="font-mono text-sm text-slate-900 font-medium">
              {ownership.ownerEmail}
            </div>
          </div>
        </section>
      ) : (
        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div className="flex items-center gap-2 pb-4 border-b border-slate-100">
            <Users className="w-4 h-4 text-slate-700" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Właściciel i współwłaściciele przestrzeni głównej
              </h2>
              <p className="text-xs text-slate-500">
                Dodani współwłaściciele współdzielą tę przestrzeń i jej ustawienia.
              </p>
            </div>
          </div>

          <div className="text-xs space-y-1">
            <span className="text-slate-500">Główny właściciel:</span>
            <div className="font-mono text-sm text-slate-900 font-medium">
              {ownership.ownerEmail}
            </div>
          </div>

          {isPrimaryOwner && (
            <form onSubmit={handleAddCoOwner} className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="email"
                value={newCoOwner}
                onChange={(e) => setNewCoOwner(e.target.value)}
                placeholder="wspolwlasciciel@gmail.com"
                className="flex-1 px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
              <button
                type="submit"
                disabled={savingAccess || !newCoOwner.trim()}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                Dodaj współwłaściciela
              </button>
            </form>
          )}

          {accessMessage && (
            <div
              role="status"
              className={`p-3 rounded-md text-xs border ${
                accessMessage.type === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {accessMessage.text}
            </div>
          )}

          <div className="space-y-2">
            <span className="text-xs font-medium text-slate-700 block">
              Lista współwłaścicieli ({coOwners.length}/10)
            </span>
            {coOwners.length === 0 ? (
              <p className="text-xs text-slate-500">
                Brak dodanych współwłaścicieli.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {coOwners.map((email) => (
                  <li
                    key={email}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                  >
                    <span className="font-mono text-slate-800">{email}</span>
                    {isPrimaryOwner && (
                      <button
                        type="button"
                        disabled={savingAccess}
                        onClick={() => void handleRemoveCoOwner(email)}
                        aria-label={`Usuń współwłaściciela ${email}`}
                        className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
