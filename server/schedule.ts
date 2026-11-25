import type { DailyStats, WarmupSettings } from '../shared/types';
import { DEFAULT_TIMEZONE } from '../shared/types';

export interface ZonedDateParts {
  dateKey: string; // YYYY-MM-DD
  hour: number;    // 0..23
  minute: number;  // 0..59
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getZonedParts(date: Date, timeZone: string = DEFAULT_TIMEZONE): ZonedDateParts {
  const safeTz = isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';

  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  const rawHour = parseInt(lookup('hour'), 10);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = parseInt(lookup('minute'), 10);

  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    minute,
  };
}

/**
 * Computes exact whole calendar days elapsed between two YYYY-MM-DD keys.
 * Immune to 23h/25h DST transition days because it uses UTC midnight arithmetic.
 */
export function diffDateKeys(startDateKey: string, currentDateKey: string): number {
  const startMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDateKey);
  const currMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(currentDateKey);
  if (!startMatch || !currMatch) return 0;

  const startUtc = Date.UTC(
    parseInt(startMatch[1], 10),
    parseInt(startMatch[2], 10) - 1,
    parseInt(startMatch[3], 10)
  );
  const currUtc = Date.UTC(
    parseInt(currMatch[1], 10),
    parseInt(currMatch[2], 10) - 1,
    parseInt(currMatch[3], 10)
  );

  const days = Math.floor((currUtc - startUtc) / 86_400_000);
  return Math.max(0, days);
}

/**
 * Ramp-up formula: min(cap, start + dayIndex * increment)
 */
export function computeDailyTarget(
  settings: Pick<WarmupSettings, 'startDateKey' | 'startDailyCount' | 'dailyIncrement' | 'maxDailyCap'>,
  currentDateKey: string
): { dayIndex: number; targetLimit: number } {
  const dayIndex = diffDateKeys(settings.startDateKey, currentDateKey);
  const rawTarget = settings.startDailyCount + dayIndex * settings.dailyIncrement;
  const targetLimit = Math.max(1, Math.min(settings.maxDailyCap, rawTarget));
  return { dayIndex, targetLimit };
}

export function isWithinSendingWindow(
  currentHour: number,
  windowStartHour: number,
  windowEndHour: number
): boolean {
  return currentHour >= windowStartHour && currentHour < windowEndHour;
}

export function computeRandomDelayMinutes(
  minDelayMinutes: number,
  maxDelayMinutes: number,
  rng: () => number = Math.random
): number {
  const min = Math.max(1, Math.floor(minDelayMinutes));
  const max = Math.max(min, Math.floor(maxDelayMinutes));
  if (min === max) return min;
  const r = Math.min(0.999999, Math.max(0, rng()));
  return min + Math.floor(r * (max - min + 1));
}

export interface SendEligibilityResult {
  eligible: boolean;
  reason?: string;
  dateKey: string;
  dayIndex: number;
  targetLimit: number;
  currentHour: number;
  withinWindow: boolean;
}

export function evaluateSendEligibility(
  settings: WarmupSettings,
  todayStats: DailyStats | null,
  now: Date,
  options: { bypassWindowAndDelay?: boolean } = {}
): SendEligibilityResult {
  const zoned = getZonedParts(now, settings.timezone);
  const { dayIndex, targetLimit } = computeDailyTarget(settings, zoned.dateKey);
  const withinWindow = isWithinSendingWindow(
    zoned.hour,
    settings.windowStartHour,
    settings.windowEndHour
  );

  if (!settings.enabled && !options.bypassWindowAndDelay) {
    return {
      eligible: false,
      reason: 'Harmonogram warm-upu jest obecnie wyłączony.',
      dateKey: zoned.dateKey,
      dayIndex,
      targetLimit,
      currentHour: zoned.hour,
      withinWindow,
    };
  }

  const sentToday = todayStats?.dateKey === zoned.dateKey ? todayStats.sentCount : 0;
  if (sentToday >= targetLimit) {
    return {
      eligible: false,
      reason: `Osiągnięto dzienny limit wysyłki (${sentToday}/${targetLimit}) dla dnia ${zoned.dateKey}.`,
      dateKey: zoned.dateKey,
      dayIndex,
      targetLimit,
      currentHour: zoned.hour,
      withinWindow,
    };
  }

  if (!options.bypassWindowAndDelay) {
    if (!withinWindow) {
      return {
        eligible: false,
        reason: `Poza oknem wysyłki (${settings.windowStartHour}:00–${settings.windowEndHour}:00 ${settings.timezone}, obecnie ${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}).`,
        dateKey: zoned.dateKey,
        dayIndex,
        targetLimit,
        currentHour: zoned.hour,
        withinWindow,
      };
    }

    if (settings.nextAllowedSendAt) {
      const nextMs = Date.parse(settings.nextAllowedSendAt);
      if (!Number.isNaN(nextMs) && now.getTime() < nextMs) {
        const remainingMin = Math.ceil((nextMs - now.getTime()) / 60_000);
        return {
          eligible: false,
          reason: `Oczekiwanie na losowy odstęp wysyłki (pozostało ok. ${remainingMin} min).`,
          dateKey: zoned.dateKey,
          dayIndex,
          targetLimit,
          currentHour: zoned.hour,
          withinWindow,
        };
      }
    }
  }

  return {
    eligible: true,
    dateKey: zoned.dateKey,
    dayIndex,
    targetLimit,
    currentHour: zoned.hour,
    withinWindow,
  };
}
