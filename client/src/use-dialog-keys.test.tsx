import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { useDialogKeys } from './use-dialog-keys';

/** A pop-up with three controls; `autofocusLast` marks the last one as where focus starts. */
function Dialog({ onClose, busy = false, autofocusLast = false }: { onClose: () => void; busy?: boolean; autofocusLast?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useDialogKeys(ref, onClose, { busy });
  return (
    <section ref={ref} role="dialog" aria-label="Test pop-up">
      <button type="button">First</button>
      <input aria-label="Middle" />
      <button type="button" data-autofocus={autofocusLast ? true : undefined}>Last</button>
    </section>
  );
}

function Page({ busy = false, onClose }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <button type="button">Elsewhere</button>
      {open && (
        <Dialog
          busy={busy}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

describe('useDialogKeys', () => {
  it('moves focus in on open, cycles Tab and Shift+Tab inside, and gives focus back on Escape', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Middle' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('starts on the element marked data-autofocus', () => {
    render(<Dialog onClose={vi.fn()} autofocusLast />);
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });

  it('ignores Escape while busy', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Page busy onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('lets only the newest of two open pop-ups answer Escape', async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <Dialog onClose={outer} />
        <Dialog onClose={inner} />
      </>,
    );
    await user.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
