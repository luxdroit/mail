import { useEffect, useState } from 'react';
import { Play, RefreshCw, Search } from 'lucide-react';
import type {
  DashboardPayload,
  LogCategory,
  MessageFormat,
  WarmupCycleResult,
  WarmupSettings,
} from '../../shared/types';

interface ScheduleDashboardViewProps {
  dashboard: DashboardPayload;
  onSaveSettings: (patch: Partial<WarmupSettings>) => Promise<void>;
  onRunCycleNow: (bypassWindowAndDelay: boolean) => Promise<WarmupCycleResult>;
  onRefresh: () => Promise<void>;
  runningCycle: boolean;
  lastCycleResult: WarmupCycleResult | null;
}

const COMMON_TIMEZONES = [
  'Europe/Warsaw',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
];

const LOG_FILTERS: Array<{ id: 'all' | LogCategory | 'errors'; label: string }> = [
  { id: 'all', label: 'Wszystkie' },
  { id: 'send', label: 'Wysyłka' },
  { id: 'imap', label: 'IMAP / Spam' },
  { id: 'reply', label: 'Odpowiedzi' },
  { id: 'ai', label: 'AI / Fallback' },
  { id: 'cron', label: 'Cron / Lock' },
  { id: 'errors', label: 'Błędy' },
];

function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('pl-PL', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

export function ScheduleDashboardView({
  dashboard,
  onSaveSettings,
  onRunCycleNow,
  onRefresh,
  runningCycle,
  lastCycleResult,
}: ScheduleDashboardViewProps) {
  const { settings, todayStats, computedSchedule, recentLogs } = dashboard;

  const [enabled, setEnabled] = useState(settings.enabled);
  const [startDateKey, setStartDateKey] = useState(settings.startDateKey);
  const [startDailyCount, setStartDailyCount] = useState(settings.startDailyCount);
  const [dailyIncrement, setDailyIncrement] = useState(settings.dailyIncrement);
  const [maxDailyCap, setMaxDailyCap] = useState(settings.maxDailyCap);
  const [minDelayMinutes, setMinDelayMinutes] = useState(settings.minDelayMinutes);
  const [maxDelayMinutes, setMaxDelayMinutes] = useState(settings.maxDelayMinutes);
  const [windowStartHour, setWindowStartHour] = useState(settings.windowStartHour);
  const [windowEndHour, setWindowEndHour] = useState(settings.windowEndHour);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [messageFormat, setMessageFormat] = useState<MessageFormat>(settings.messageFormat);
  const [bypassWindowAndDelay, setBypassWindowAndDelay] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [logFilter, setLogFilter] = useState<'all' | LogCategory | 'errors'>('all');
  const [logQuery, setLogQuery] = useState('');

  useEffect(() => {
    setEnabled(settings.enabled);
    setStartDateKey(settings.startDateKey);
    setStartDailyCount(settings.startDailyCount);
    setDailyIncrement(settings.dailyIncrement);
    setMaxDailyCap(settings.maxDailyCap);
    setMinDelayMinutes(settings.minDelayMinutes);
    setMaxDelayMinutes(settings.maxDelayMinutes);
    setWindowStartHour(settings.windowStartHour);
    setWindowEndHour(settings.windowEndHour);
    setTimezone(settings.timezone);
    setMessageFormat(settings.messageFormat);
  }, [settings]);

  const progressPct =
    computedSchedule.targetLimit > 0
      ? Math.min(100, Math.round((todayStats.sentCount / computedSchedule.targetLimit) * 100))
      : 0;

  const filteredLogs = recentLogs.filter((log) => {
    if (logFilter === 'errors' && log.level !== 'error') return false;
    if (logFilter !== 'all' && logFilter !== 'errors' && log.category !== logFilter) return false;
    if (logQuery.trim()) {
      const q = logQuery.trim().toLowerCase();
      return (
        log.message.toLowerCase().includes(q) ||
        log.category.toLowerCase().includes(q) ||
        log.level.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveMessage(null);
    try {
      await onSaveSettings({
        enabled,
        startDateKey,
        startDailyCount: Number(startDailyCount),
        dailyIncrement: Number(dailyIncrement),
        maxDailyCap: Number(maxDailyCap),
        minDelayMinutes: Number(minDelayMinutes),
        maxDelayMinutes: Number(maxDelayMinutes),
        windowStartHour: Number(windowStartHour),
        windowEndHour: Number(windowEndHour),
        timezone,
        messageFormat,
      });
      setSaveMessage({ type: 'ok', text: 'Zapisano parametry harmonogramu w Firestore.' });
    } catch (err) {
      setSaveMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Nie udało się zapisać harmonogramu.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Daily Progress KPI Strip */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Postęp dnia ({computedSchedule.dateKey})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Dzień ramp-upu: <span className="font-mono tabular-nums">#{computedSchedule.dayIndex}</span>
              {' · '}
              Strefa: <span className="font-mono">{settings.timezone}</span>
              {' · '}
              Okno wysyłki:{' '}
              <span className={computedSchedule.withinWindow ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                {computedSchedule.withinWindow ? 'Otwarte teraz' : 'Poza oknem'}
              </span>
            </p>
          </div>
          <div className="sm:text-right">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900">
              {todayStats.sentCount} / {computedSchedule.targetLimit}
            </span>
            <p className="text-xs text-slate-500 tabular-nums">
              {progressPct}% dziennego limitu
            </p>
          </div>
        </div>

        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-700 transition-all duration-200"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <dl className="grid grid-cols-2 md:grid-cols-4 gap-6 pt-3 border-t border-slate-100">
          <div>
            <dt className="text-xs text-slate-500">Odpowiedzi w wątkach</dt>
            <dd className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
              {todayStats.repliedCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Wyciągnięte ze Spamu</dt>
            <dd className="mt-1 text-xl font-semibold font-mono tabular-nums text-amber-700">
              {todayStats.rescuedFromSpamCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Użycia szablonów fallback</dt>
            <dd className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
              {todayStats.fallbackCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Błędy dzisiaj</dt>
            <dd
              className={`mt-1 text-xl font-semibold font-mono tabular-nums ${
                todayStats.errorCount > 0 ? 'text-red-700' : 'text-slate-900'
              }`}
            >
              {todayStats.errorCount}
            </dd>
          </div>
        </dl>
      </section>

      {/* Schedule Controls & Manual Trigger */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form
          onSubmit={handleSave}
          className="lg:col-span-8 bg-white border border-slate-200 rounded-lg p-6 space-y-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Harmonogram i ramp-up</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Wzór dziennego limitu: <span className="font-mono">min(cap, start + dzień × przyrost)</span>
              </p>
            </div>
            <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="w-4 h-4 accent-blue-700 rounded"
              />
              <span className="text-sm font-medium text-slate-900">
                Warm-up aktywny ({enabled ? 'Włączony' : 'Wstrzymany'})
              </span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Maile na start (dzień 0)</span>
              <input
                type="number"
                min={1}
                max={200}
                value={startDailyCount}
                onChange={(e) => setStartDailyCount(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Dzienny przyrost (ramp-up)</span>
              <input
                type="number"
                min={0}
                max={50}
                value={dailyIncrement}
                onChange={(e) => setDailyIncrement(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Maksymalny limit dzienny (cap)</span>
              <input
                type="number"
                min={1}
                max={500}
                value={maxDailyCap}
                onChange={(e) => setMaxDailyCap(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Min. odstęp (min)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={minDelayMinutes}
                onChange={(e) => setMinDelayMinutes(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Maks. odstęp (min)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={maxDelayMinutes}
                onChange={(e) => setMaxDelayMinutes(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Okno od (godz.)</span>
              <input
                type="number"
                min={0}
                max={23}
                value={windowStartHour}
                onChange={(e) => setWindowStartHour(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Okno do (godz.)</span>
              <input
                type="number"
                min={1}
                max={24}
                value={windowEndHour}
                onChange={(e) => setWindowEndHour(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Strefa czasowa</span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Data startu ramp-upu</span>
              <input
                type="date"
                value={startDateKey}
                onChange={(e) => setStartDateKey(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </label>
          </div>

          {/* Message Format Selector */}
          <div className="pt-4 border-t border-slate-100 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">Format wysyłanych wiadomości</span>
              <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-md self-start">
                <button
                  type="button"
                  onClick={() => setMessageFormat('plain')}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    messageFormat === 'plain'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Plain Text (domyślny)
                </button>
                <button
                  type="button"
                  onClick={() => setMessageFormat('light_html')}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    messageFormat === 'light_html'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Lekki HTML (multipart/alternative)
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              {messageFormat === 'plain'
                ? 'Wpływ na dostarczalność: Plain Text maksymalnie przypomina naturalną korespondencję 1:1 i minimalizuje ryzyko punktów spamowych na starcie rozgrzewania domeny.'
                : 'Wpływ na dostarczalność: Lekki HTML (multipart/alternative z wersją tekstową, bez zdalnych obrazków, linków i trackerów) buduje reputację dla kampanii HTML po początkowym etapie rozgrzewania.'}
            </p>
          </div>

          {saveMessage && (
            <div
              role="status"
              className={`p-3 rounded-md text-xs border ${
                saveMessage.type === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {saveMessage.text}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
            >
              {saving ? 'Zapisywanie...' : 'Zapisz harmonogram'}
            </button>
          </div>
        </form>

        {/* Manual Trigger & Next Window Card */}
        <aside className="lg:col-span-4 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Sterowanie ręczne</h2>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
              Wykonuje bezpiecznie 1 bezstanowy cykl: wysyła maks. 1 wiadomość ze skrzynki głównej
              oraz skanuje IMAP/Spam na skrzynkach pomocniczych.
            </p>
          </div>

          <dl className="space-y-2.5 text-xs pt-2 border-t border-slate-100">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Ostatnia wysyłka</dt>
              <dd className="font-mono tabular-nums text-slate-900">
                {formatDateTime(settings.lastSentAt)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Najwcześniej kolejna</dt>
              <dd className="font-mono tabular-nums text-slate-900">
                {formatDateTime(settings.nextAllowedSendAt)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Aktywny lock Firestore</dt>
              <dd className="font-mono text-slate-900">
                {dashboard.activeLock ? `Zajęty (${dashboard.activeLock.source})` : 'Wolny'}
              </dd>
            </div>
          </dl>

          <label className="flex items-start gap-2.5 text-xs text-slate-600 cursor-pointer pt-2 border-t border-slate-100">
            <input
              type="checkbox"
              checked={bypassWindowAndDelay}
              onChange={(e) => setBypassWindowAndDelay(e.target.checked)}
              className="mt-0.5 accent-blue-700"
            />
            <span>Pomiń okno godzinowe i odstęp czasowy przy tym ręcznym uruchomieniu</span>
          </label>

          <button
            type="button"
            disabled={runningCycle}
            onClick={() => void onRunCycleNow(bypassWindowAndDelay)}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
          >
            <Play className="w-4 h-4" />
            {runningCycle ? 'Wykonywanie cyklu...' : 'Wykonaj cykl ręcznie'}
          </button>

          {lastCycleResult && (
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md text-xs space-y-1.5">
              <div className="flex items-center justify-between font-medium text-slate-900">
                <span>Wynik cyklu: {lastCycleResult.status}</span>
                <span className="font-mono tabular-nums text-slate-500">
                  {lastCycleResult.durationMs} ms
                </span>
              </div>
              <p className="text-slate-600">
                Wysłano: {lastCycleResult.sent ? `Tak (${lastCycleResult.sentTo})` : 'Nie'} ·
                Sprawdzono IMAP: {lastCycleResult.checkedHelpers} · Odpowiedzi:{' '}
                {lastCycleResult.repliedCount} · Ze Spamu: {lastCycleResult.rescuedFromSpamCount}
              </p>
              {lastCycleResult.skippedReason && (
                <p className="text-amber-800">{lastCycleResult.skippedReason}</p>
              )}
              {lastCycleResult.errors.length > 0 && (
                <p className="text-red-700">{lastCycleResult.errors.join(' | ')}</p>
              )}
            </div>
          )}
        </aside>
      </div>

      {/* Recent Logs Table */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-slate-900">Ostatnie logi operacyjne</h2>
            <button
              type="button"
              onClick={() => void onRefresh()}
              aria-label="Odśwież logi"
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md">
              {LOG_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setLogFilter(f.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    logFilter === f.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={logQuery}
                onChange={(e) => setLogQuery(e.target.value)}
                placeholder="Szukaj w logach..."
                className="pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-700 w-48"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Brak zdarzeń spełniających wybrane kryteria. Uruchom test połączenia lub pierwszy cykl
              warm-upu, aby zobaczyć historię.
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4 whitespace-nowrap">Czas</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Poziom</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Kategoria</th>
                  <th className="py-2.5 px-4">Komunikat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {formatDateTime(log.createdAt)}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap font-medium">
                      <span
                        className={
                          log.level === 'error'
                            ? 'text-red-700'
                            : log.level === 'warn'
                              ? 'text-amber-700'
                              : 'text-emerald-700'
                        }
                      >
                        {log.level === 'error'
                          ? 'Błąd'
                          : log.level === 'warn'
                            ? 'Ostrzeżenie'
                            : 'Info'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                      {log.category}
                    </td>
                    <td className="py-2.5 px-4 text-slate-800 leading-relaxed">{log.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
