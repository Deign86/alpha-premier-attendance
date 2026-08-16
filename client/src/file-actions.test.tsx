import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tauriApi } from './tauri-api';
import { GeneratedFileActions, type GeneratedFileResult } from './file-actions';

const fileResult: GeneratedFileResult = {
  filePath: 'C:\\Users\\Admin\\AppData\\Local\\com.alphapremier.attendance\\exports\\payroll-2026-08-04.csv',
  directoryPath: 'C:\\Users\\Admin\\AppData\\Local\\com.alphapremier.attendance\\exports',
  fileName: 'payroll-2026-08-04.csv',
  fileKind: 'csv',
  isPortableMode: false,
};

describe('GeneratedFileActions', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // SAFETY: Clean up mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('renders Open file and Show in folder when a file path exists', () => {
    render(<GeneratedFileActions result={fileResult} label="Payroll export" />);
    expect(screen.getByText('Payroll export')).toBeInTheDocument();
    expect(screen.getByText('payroll-2026-08-04.csv')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open file/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show in folder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy path/i })).toBeInTheDocument();
    expect(screen.getByText('Installed mode')).toBeInTheDocument();
  });

  it('opens the file when Open file is clicked', async () => {
    const spy = vi.spyOn(tauriApi, 'openGeneratedFile').mockResolvedValueOnce({ success: true, message: 'File opened.' });
    const user = userEvent.setup();
    render(<GeneratedFileActions result={fileResult} />);
    await user.click(screen.getByRole('button', { name: /open file/i }));
    expect(spy).toHaveBeenCalledWith('', fileResult.filePath);
    expect(await screen.findByText('File opened.')).toBeInTheDocument();
  });

  it('reveals the exact file when Show in folder is clicked', async () => {
    const spy = vi.spyOn(tauriApi, 'revealGeneratedFile').mockResolvedValueOnce({ success: true, message: 'File revealed in folder.' });
    const user = userEvent.setup();
    render(<GeneratedFileActions result={fileResult} />);
    await user.click(screen.getByRole('button', { name: /show in folder/i }));
    expect(spy).toHaveBeenCalledWith('', fileResult.filePath);
    expect(await screen.findByText('File revealed in folder.')).toBeInTheDocument();
  });

  it('renders Open folder when only a directory path exists', () => {
    render(<GeneratedFileActions result={{ filePath: null, directoryPath: 'C:\\Data\\exports', fileName: null, fileKind: 'csv', isPortableMode: true }} />);
    expect(screen.getByRole('button', { name: /open folder/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open file/i })).not.toBeInTheDocument();
    expect(screen.getByText('Portable mode')).toBeInTheDocument();
  });

  it('opens the directory when Open folder is clicked', async () => {
    const spy = vi.spyOn(tauriApi, 'openGeneratedDirectory').mockResolvedValueOnce({ success: true, message: 'Folder opened.' });
    const user = userEvent.setup();
    render(<GeneratedFileActions result={{ filePath: null, directoryPath: 'C:\\Data\\exports', fileName: null, fileKind: 'csv', isPortableMode: true }} />);
    await user.click(screen.getByRole('button', { name: /open folder/i }));
    expect(spy).toHaveBeenCalledWith('', 'C:\\Data\\exports');
    expect(await screen.findByText('Folder opened.')).toBeInTheDocument();
  });

  it('renders nothing when no paths are available', () => {
    const { container } = render(<GeneratedFileActions result={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces a friendly message when the file action fails', async () => {
    vi.spyOn(tauriApi, 'openGeneratedFile').mockRejectedValueOnce('FILE_NOT_FOUND');
    const user = userEvent.setup();
    render(<GeneratedFileActions result={fileResult} />);
    await user.click(screen.getByRole('button', { name: /open file/i }));
    expect(await screen.findByText('The file could not be found. It may have been moved or deleted.')).toBeInTheDocument();
  });
});
