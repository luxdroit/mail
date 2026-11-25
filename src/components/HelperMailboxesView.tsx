import { useState } from 'react';
import { Pencil, PlugZap, Plus, Trash2, X } from 'lucide-react';
import type {
  MailboxInput,
  MailboxPublic,
  MailboxTestResult,
  SecurityMode,
} from '../../shared/types';

interface HelperMailboxesViewProps {
  helpers: MailboxPublic[];
  encryptionReady: boolean;
  onCreateHelper: (input: MailboxInput) => Promise<MailboxPublic>;
  onUpdateHelper: (id: string, input: Partial<MailboxInput>) => Promise<MailboxPublic>;
  onDeleteHelper: (id: string) => Promise<void>;
  onTestMailbox: (id: string) => Promise<MailboxTestResult>;
}

interface FormState {
  id?: string;
  label: string;
  email: string;
  password: string;
  security: SecurityMode;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  active: boolean;
  hasExistingPassword: boolean;
}

const EMPTY_FORM: FormState = {
  label: '',
  email: '',
  password: '',
  security: 'ssl_tls',
  smtpHost: '',
  smtpPort: 465,
  imapHost: '',
  imapPort: 993,
  active: true,
  hasExistingPassword: false,
};

export function HelperMailboxesView({
  helpers,
  encryptionReady,
  onCreateHelper,
  onUpdateHelper,
  onDeleteHelper,
  onTestMailbox,
}: HelperMailboxesViewProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, MailboxTestResult>>({});
  const [banner, setBanner] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setBanner(null);
    setFormOpen(true);
  };

  const openEdit = (box: MailboxPublic) => {
    setForm({
      id: box.id,
      label: box.label,
      email: box.email,
      password: '', // Never populated from server
      security: box.smtpSecurity,
      smtpHost: box.smtpHost,
      smtpPort: box.smtpPort,
      imapHost: box.imapHost,
      imapPort: box.imapPort,
      active: box.active,
      hasExistingPassword: box.hasPassword,
    });
    setBanner(null);
    setFormOpen(true);
  };

  const setPreset = (mode: SecurityMode) => {
    setForm((prev) => ({
      ...prev,
      security: mode,
      smtpPort: mode === 'ssl_tls' ? 465 : 587,
      imapPort: mode === 'ssl_tls' ? 993 : 143,
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setBanner(null);
    try {
      const payload: MailboxInput = {
        role: 'helper',
        label: form.label.trim(),
        email: form.email.trim(),
        password: form.password.length > 0 ? form.password : undefined,
        smtpHost: form.smtpHost.trim(),
        smtpPort: Number(form.smtpPort),
        smtpSecurity: form.security,
        imapHost: form.imapHost.trim(),
        imapPort: Number(form.imapPort),
        imapSecurity: form.security,
        active: form.active,
      };
      if (form.id) {
        await onUpdateHelper(form.id, payload);
        setBanner({ type: 'ok', text: `Zaktualizowano skrzynkę pomocniczą ${payload.email}.` });
      } else {
        await onCreateHelper(payload);
        setBanner({ type: 'ok', text: `Dodano skrzynkę pomocniczą ${payload.email}.` });
      }
      setFormOpen(false);
      setForm(EMPTY_FORM);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Błąd zapisu skrzynki pomocniczej.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (box: MailboxPublic) => {
    setBanner(null);
    try {
      await onUpdateHelper(box.id, { active: !box.active });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się zmienić statusu skrzynki.',
      });
    }
  };

  const handleTest = async (box: MailboxPublic) => {
    setTestingId(box.id);
    setBanner(null);
    try {
      const res = await onTestMailbox(box.id);
      setTestResults((prev) => ({ ...prev, [box.id]: res }));
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : `Test skrzynki ${box.email} nie powiódł się.`,
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (box: MailboxPublic) => {
    setDeletingId(box.id);
    setBanner(null);
    try {
      await onDeleteHelper(box.id);
      setBanner({ type: 'ok', text: `Usunięto skrzynkę pomocniczą ${box.email}.` });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się usunąć skrzynki.',
      });
    } finally {
      setDeletingId(null);
    }
  };

  const activeCount = helpers.filter((h) => h.active).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Skrzynki pomocnicze (pula rotacji)</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Łącznie: <span className="font-mono tabular-nums">{helpers.length}</span> · Aktywne:{' '}
            <span className="font-mono tabular-nums">{activeCount}</span> · Hasła są zawsze maskowane i
            szyfrowane po stronie serwera.
          </p>
        </div>

        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          Dodaj skrzynkę pomocniczą
        </button>
      </div>

      {banner && (
        <div
          role="status"
          className={`p-3 rounded-md text-xs border ${
            banner.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Add / Edit Form Panel */}
      {formOpen && (
        <form
          onSubmit={handleSave}
          className="bg-white border border-slate-200 rounded-lg p-6 space-y-5"
        >
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-900">
              {form.id ? 'Edytuj skrzynkę pomocniczą' : 'Nowa skrzynka pomocnicza'}
            </h3>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              aria-label="Zamknij formularz"
              className="p-1 text-slate-500 hover:text-slate-900 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Etykieta / nazwa</span>
              <input
                type="text"
                required
                value={form.label}
                onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
                placeholder="np. Gmail pomocnicza #1"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Adres e-mail</span>
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                placeholder="pomocnicza@domena.pl"
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700">
              Hasło / hasło aplikacji{' '}
              {form.hasExistingPassword ? '(puste = bez zmian)' : '(wymagane)'}
            </span>
            <input
              type="password"
              autoComplete="new-password"
              required={!form.hasExistingPassword}
              value={form.password}
              onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
              placeholder={
                form.hasExistingPassword
                  ? '•••••••••••••••• (zaszyfrowane)'
                  : 'Wpisz hasło aplikacji SMTP/IMAP'
              }
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </label>

          <div className="space-y-2">
            <span className="text-xs font-medium text-slate-700 block">Tryb szyfrowania</span>
            <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-md">
              <button
                type="button"
                onClick={() => setPreset('ssl_tls')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  form.security === 'ssl_tls'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                SSL/TLS (465 / 993)
              </button>
              <button
                type="button"
                onClick={() => setPreset('starttls')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  form.security === 'starttls'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                STARTTLS (587 / 143)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <label className="sm:col-span-8 block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Host SMTP</span>
              <input
                type="text"
                required
                value={form.smtpHost}
                onChange={(e) => setForm((p) => ({ ...p, smtpHost: e.target.value }))}
                placeholder="smtp.poczta.pl"
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
                value={form.smtpPort}
                onChange={(e) => setForm((p) => ({ ...p, smtpPort: Number(e.target.value) }))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>

            <label className="sm:col-span-8 block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Host IMAP</span>
              <input
                type="text"
                required
                value={form.imapHost}
                onChange={(e) => setForm((p) => ({ ...p, imapHost: e.target.value }))}
                placeholder="imap.poczta.pl"
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
                value={form.imapPort}
                onChange={(e) => setForm((p) => ({ ...p, imapPort: Number(e.target.value) }))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
          </div>

          {!encryptionReady && (
            <p className="text-xs text-amber-800">
              Ustaw <span className="font-mono">ENCRYPTION_KEY</span> w Secrets, aby zapisać nowe hasło.
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors"
            >
              Anuluj
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors"
            >
              {submitting ? 'Zapisywanie...' : form.id ? 'Zapisz zmiany' : 'Dodaj skrzynkę'}
            </button>
          </div>
        </form>
      )}

      {/* Helper Mailboxes Table */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {helpers.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm font-medium text-slate-900">Brak skrzynek pomocniczych</p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Dodaj co najmniej jedną skrzynkę pomocniczą (np. Gmail, Outlook, własna domena), która
              będzie odbierać wiadomości, ratować je ze Spamu i odpowiadać w wątkach.
            </p>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Dodaj pierwszą skrzynkę
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-3 px-4">Skrzynka</th>
                  <th className="py-3 px-4">SMTP / IMAP</th>
                  <th className="py-3 px-4">Hasło</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Akcje</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {helpers.map((box) => {
                  const res = testResults[box.id];
                  return (
                    <tr key={box.id} className="hover:bg-slate-50/70 transition-colors align-top">
                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-900">{box.label}</div>
                        <div className="font-mono text-slate-600 mt-0.5">{box.email}</div>
                        {(res || box.lastTestMessage) && (
                          <div
                            className={`mt-1.5 text-[11px] leading-snug ${
                              (res ? res.ok : box.lastTestStatus === 'ok')
                                ? 'text-emerald-700'
                                : 'text-red-700'
                            }`}
                          >
                            {res
                              ? `${res.smtp.message} · ${res.imap.message}`
                              : box.lastTestMessage}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                        <div>
                          SMTP: {box.smtpHost}:{box.smtpPort}
                        </div>
                        <div className="mt-0.5">
                          IMAP: {box.imapHost}:{box.imapPort} ({box.imapSecurity === 'ssl_tls' ? 'SSL/TLS' : 'STARTTLS'})
                        </div>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                        {box.hasPassword ? '•••••••• (AES-256)' : 'Brak hasła'}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void handleToggleActive(box)}
                          aria-label={`Przełącz aktywność skrzynki ${box.email}`}
                          className={`text-xs font-medium underline underline-offset-4 ${
                            box.active ? 'text-emerald-700' : 'text-slate-500'
                          }`}
                        >
                          {box.active ? 'Aktywna' : 'Wyłączona'}
                        </button>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            disabled={testingId === box.id || !box.hasPassword}
                            onClick={() => void handleTest(box)}
                            aria-label={`Testuj połączenie ${box.email}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded"
                          >
                            <PlugZap className="w-3.5 h-3.5" />
                            {testingId === box.id ? 'Test...' : 'Testuj'}
                          </button>
                          <button
                            type="button"
                            onClick={() => openEdit(box)}
                            aria-label={`Edytuj ${box.email}`}
                            className="p-1.5 text-slate-600 hover:text-slate-900 border border-slate-200 rounded hover:bg-slate-50"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={deletingId === box.id}
                            onClick={() => void handleDelete(box)}
                            aria-label={`Usuń ${box.email}`}
                            className="p-1.5 text-red-600 hover:text-red-800 border border-slate-200 rounded hover:bg-red-50 disabled:opacity-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
