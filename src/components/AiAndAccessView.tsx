import { useEffect, useState } from 'react';
import { CheckCircle2, Plus, Sparkles, Trash2, Users, AlertTriangle } from 'lucide-react';
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
  secrets: SecretsStatus;
  onSaveSettings: (patch: Partial<WarmupSettings> & { coOwnerEmails?: string[] }) => Promise<void>;
  onTestAi: (model: string) => Promise<AiTestResult>;
}

export function AiAndAccessView({
  settings,
  ownership,
  isPrimaryOwner,
  secrets,
  onSaveSettings,
  onTestAi,
}: AiAndAccessViewProps) {
  const isPreset = RECOMMENDED_AI_MODELS.some((m) => m.id === settings.aiModel);
  const [selectedModel, setSelectedModel] = useState(isPreset ? settings.aiModel : '__custom__');
  const [customModel, setCustomModel] = useState(isPreset ? '' : settings.aiModel);
  const [savingAi, setSavingAi] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiResult, setAiResult] = useState<AiTestResult | null>(null);
  const [aiMessage, setAiMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const [coOwners, setCoOwners] = useState<string[]>(ownership.coOwnerEmails);
  const [newCoOwner, setNewCoOwner] = useState('');
  const [savingAccess, setSavingAccess] = useState(false);
  const [accessMessage, setAccessMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(
    null
  );

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
      await onSaveSettings({ aiModel: effectiveModel });
      setAiMessage({ type: 'ok', text: `Zapisano model AI: ${effectiveModel}.` });
    } catch (err) {
      setAiMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się zapisać modelu AI.',
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
      {/* Gemini AI Config */}
      <form
        onSubmit={handleSaveModel}
        className="bg-white border border-slate-200 rounded-lg p-6 space-y-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Konfiguracja Gemini AI i fallback</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Generowanie naturalnych konwersacji B2B i odpowiedzi po stronie serwera (@google/genai).
            </p>
          </div>
          <span
            className={`text-xs font-medium ${
              secrets.hasGeminiKey ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {secrets.hasGeminiKey
              ? 'GEMINI_API_KEY obecny · Fallback gotowy'
              : 'Tryb fallback aktywny (brak GEMINI_API_KEY)'}
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

          <p className="text-xs text-slate-500 leading-relaxed">
            W razie błędu limitu <span className="font-mono">429</span>, błędu sieci, nieobsługiwanego
            modelu (<span className="font-mono">404</span>) lub braku klucza API, silnik automatycznie
            przełączy się na wbudowaną pulę neutralnych szablonów konwersacyjnych i zapisze to w logach.
          </p>
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
                Przykładowy temat: <span className="font-medium">{aiResult.sampleSubject}</span>
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
            {testingAi ? 'Testowanie Gemini...' : 'Testuj połączenie z Gemini API'}
          </button>

          <button
            type="submit"
            disabled={savingAi}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
          >
            {savingAi ? 'Zapisywanie...' : 'Zapisz model'}
          </button>
        </div>
      </form>

      {/* Owner & Co-Owners Management */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex items-center gap-2 pb-4 border-b border-slate-100">
          <Users className="w-4 h-4 text-slate-700" />
          <div>
            <h2 className="text-base font-semibold text-slate-900">Właściciel i współwłaściciele</h2>
            <p className="text-xs text-slate-500">
              Wszystkie pozostałe konta Google otrzymują odpowiedź 403 Forbidden.
            </p>
          </div>
        </div>

        <div className="text-xs space-y-1">
          <span className="text-slate-500">Główny właściciel (zapisany przy 1. logowaniu):</span>
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
              Brak dodanych współwłaścicieli — dostęp ma wyłącznie Twoje konto główne.
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
    </div>
  );
}
