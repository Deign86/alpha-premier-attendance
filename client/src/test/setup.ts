import '@testing-library/jest-dom';
import { beforeEach } from 'vitest';
import { setFridayReminderClockForTests } from '../backup-reminder';

// The admin page's Friday backup reminder reads the real clock. Pin it to a Thursday so admin screens make the same
// requests on any weekday; the reminder's own tests pass their own clock.
beforeEach(() => {
  setFridayReminderClockForTests(() => new Date('2026-10-29T12:00:00+08:00'));
});
