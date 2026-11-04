import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Toasts, showToast } from './toasts';

describe('Toasts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a success note politely and hides it by itself', () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => showToast('User saved.'));

    expect(screen.getByText('User saved.')).toBeInTheDocument();
    // Read once when added; the notes already shown are not read again.
    const region = screen.getByText('User saved.').closest('[aria-live]');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-relevant', 'additions');
    expect(region).not.toHaveAttribute('role');

    act(() => vi.advanceTimersByTime(3_400));
    expect(screen.getByText('User saved.')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText('User saved.')).not.toBeInTheDocument();
  });

  it('closes a note early with its dismiss button', () => {
    render(<Toasts />);
    act(() => showToast('Backup created'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Backup created' }));
    expect(screen.queryByText('Backup created')).not.toBeInTheDocument();
  });

  it('keeps at most three notes, dropping the oldest', () => {
    render(<Toasts />);
    act(() => {
      showToast('First');
      showToast('Second');
      showToast('Third');
      showToast('Fourth');
    });
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Fourth')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Dismiss: / })).toHaveLength(3);
  });

  it('drops waiting notes when the toast corner goes away', () => {
    const { unmount } = render(<Toasts />);
    act(() => showToast('Payroll finalized.'));
    unmount();
    render(<Toasts />);
    expect(screen.queryByText('Payroll finalized.')).not.toBeInTheDocument();
  });
});
