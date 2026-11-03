import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoadFailed, LoadingRows, useListLoad } from './list-load';

/** A list that shows its rows, placeholder rows while loading, and the failed line with Retry. */
function Names({ load }: { load: () => Promise<string[]> }) {
  const list = useListLoad(load, []);
  return (
    <>
      {list.status === 'failed' && <LoadFailed what="names" onRetry={() => void list.reload()} />}
      <table>
        <tbody>
          {list.status === 'loading' ? (
            <LoadingRows columns={1} label="Loading names…" />
          ) : (
            list.data.map((name) => (
              <tr key={name}>
                <td>{name}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

describe('useListLoad', () => {
  it('shows loading rows, then the rows', async () => {
    render(<Names load={async () => ['Juan Dela Cruz']} />);
    expect(screen.getByText('Loading names…')).toBeInTheDocument();
    expect(await screen.findByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(screen.queryByText('Loading names…')).not.toBeInTheDocument();
  });

  it('shows a failed load with Retry that loads the list again', async () => {
    const load = vi.fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(['Maria Clara']);
    const user = userEvent.setup();
    render(<Names load={load} />);

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load names.");
    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('Maria Clara')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
