import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sortByTime, useTimeOrder } from './time-sort';

type Row = { name: string; at: string | null };
const rows: Row[] = [
  { name: 'nine', at: '2026-07-28T09:00:00+08:00' },
  { name: 'none', at: null },
  { name: 'one pm', at: '2026-07-28T13:00:00+08:00' },
  { name: 'empty', at: '' },
  { name: 'eight', at: '2026-07-28T08:00:00+08:00' },
  { name: 'also nine', at: '2026-07-28T09:00:00+08:00' },
  { name: 'unreadable', at: 'soon' },
];
const names = (list: Row[]) => list.map((row) => row.name);

describe('sort by time', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('puts the latest first or the earliest first, rows without a readable time last, equal times in their order', () => {
    expect(names(sortByTime(rows, (row) => row.at, 'newest'))).toEqual(['one pm', 'nine', 'also nine', 'eight', 'none', 'empty', 'unreadable']);
    expect(names(sortByTime(rows, (row) => row.at, 'oldest'))).toEqual(['eight', 'nine', 'also nine', 'one pm', 'none', 'empty', 'unreadable']);
    // The list it was given stays as it was.
    expect(names(rows)[0]).toBe('nine');
  });

  it('starts newest first, toggles, and remembers the choice in this browser', () => {
    const { result, unmount } = renderHook(() => useTimeOrder('test_sort'));
    expect(result.current[0]).toBe('newest');
    act(() => result.current[1]());
    expect(result.current[0]).toBe('oldest');
    expect(localStorage.getItem('test_sort')).toBe('oldest');
    unmount();
    expect(renderHook(() => useTimeOrder('test_sort')).result.current[0]).toBe('oldest');
  });

  it('still works when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTimeOrder('test_sort'));
    expect(result.current[0]).toBe('newest');
    act(() => result.current[1]());
    expect(result.current[0]).toBe('oldest');
  });
});
