import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDailyTarget,
  computeRandomDelayMinutes,
  diffDateKeys,
  evaluateSendEligibility,
  getZonedParts,
  isWithinSendingWindow,
} from './schedule';
import { createDefaultSettings } from './firestoreStore';

test('ramp-up formula computes min(cap, start + dayIndex * increment)', () => {
  const cfg = {
    startDateKey: '2026-03-01',
    startDailyCount: 4,
    dailyIncrement: 3,
    maxDailyCap: 15,
  };

  assert.deepEqual(computeDailyTarget(cfg, '2026-03-01'), { dayIndex: 0, targetLimit: 4 });
  assert.deepEqual(computeDailyTarget(cfg, '2026-03-02'), { dayIndex: 1, targetLimit: 7 });
  assert.deepEqual(computeDailyTarget(cfg, '2026-03-04'), { dayIndex: 3, targetLimit: 13 });
  assert.deepEqual(computeDailyTarget(cfg, '2026-03-05'), { dayIndex: 4, targetLimit: 15 });
  assert.deepEqual(computeDailyTarget(cfg, '2026-04-01'), { dayIndex: 31, targetLimit: 15 });
});

test('Europe/Warsaw day rollover and DST spring-forward/fall-back transitions', () => {
  // Winter CET (UTC+1): 2026-01-15T23:30:00Z is already 2026-01-16 00:30 in Warsaw
  const winterRollover = getZonedParts(new Date('2026-01-15T23:30:00Z'), 'Europe/Warsaw');
  assert.equal(winterRollover.dateKey, '2026-01-16');
  assert.equal(winterRollover.hour, 0);
  assert.equal(winterRollover.minute, 30);

  // Summer CEST (UTC+2): 2026-07-15T22:15:00Z is already 2026-07-16 00:15 in Warsaw
  const summerRollover = getZonedParts(new Date('2026-07-15T22:15:00Z'), 'Europe/Warsaw');
  assert.equal(summerRollover.dateKey, '2026-07-16');
  assert.equal(summerRollover.hour, 0);
  assert.equal(summerRollover.minute, 15);

  // Across DST transition (2026-03-29 is 23-hour day in Warsaw, 2026-10-25 is 25-hour day)
  assert.equal(diffDateKeys('2026-03-28', '2026-03-30'), 2);
  assert.equal(diffDateKeys('2026-10-24', '2026-10-26'), 2);
});

test('sending window and random delay bounds', () => {
  assert.equal(isWithinSendingWindow(7, 8, 18), false);
  assert.equal(isWithinSendingWindow(8, 8, 18), true);
  assert.equal(isWithinSendingWindow(17, 8, 18), true);
  assert.equal(isWithinSendingWindow(18, 8, 18), false);

  assert.equal(computeRandomDelayMinutes(15, 45, () => 0), 15);
  assert.equal(computeRandomDelayMinutes(15, 45, () => 0.999), 45);
  assert.equal(computeRandomDelayMinutes(20, 20, () => 0.5), 20);
});

test('evaluateSendEligibility enforces enabled, window, cap, and delay', () => {
  const settings = {
    ...createDefaultSettings('uid1', ['owner@example.com']),
    enabled: true,
    startDateKey: '2026-05-10',
    startDailyCount: 2,
    dailyIncrement: 1,
    maxDailyCap: 10,
    windowStartHour: 9,
    windowEndHour: 17,
    timezone: 'Europe/Warsaw',
  };

  // 2026-05-10 10:00 Warsaw (08:00 UTC in CEST)
  const insideWindow = new Date('2026-05-10T08:00:00Z');
  const resOk = evaluateSendEligibility(settings, null, insideWindow);
  assert.equal(resOk.eligible, true);
  assert.equal(resOk.targetLimit, 2);

  // Outside window: 2026-05-10 07:00 Warsaw (05:00 UTC)
  const outsideWindow = new Date('2026-05-10T05:00:00Z');
  const resOut = evaluateSendEligibility(settings, null, outsideWindow);
  assert.equal(resOut.eligible, false);
  assert.match(resOut.reason ?? '', /Poza oknem/);

  // Daily cap reached
  const resCap = evaluateSendEligibility(
    settings,
    {
      ownerUid: 'uid1',
      allowedEmails: ['owner@example.com'],
      dateKey: '2026-05-10',
      dayIndex: 0,
      targetLimit: 2,
      sentCount: 2,
      repliedCount: 0,
      rescuedFromSpamCount: 0,
      fallbackCount: 0,
      errorCount: 0,
      updatedAt: insideWindow.toISOString(),
    },
    insideWindow
  );
  assert.equal(resCap.eligible, false);
  assert.match(resCap.reason ?? '', /Osiągnięto dzienny limit/);

  // Waiting for random delay
  const resDelay = evaluateSendEligibility(
    { ...settings, nextAllowedSendAt: '2026-05-10T08:25:00Z' },
    null,
    insideWindow
  );
  assert.equal(resDelay.eligible, false);
  assert.match(resDelay.reason ?? '', /losowy odstęp/);
});
