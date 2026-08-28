import { useState } from 'react';
import { Check, Copy, ExternalLink, FolderOpen, Search } from 'lucide-react';
import type { GeneratedFileKind } from '@rfid-attendance/shared';
import { openGeneratedDirectory, openGeneratedFile, revealGeneratedFile, type FileActionResult } from './api';

export type GeneratedFileResult = {
  filePath: string | null;
  directoryPath: string | null;
  fileName: string | null;
  fileKind?: GeneratedFileKind | null;
  isPortableMode?: boolean;
  message?: string;
};

type FileActionResultProps = {
  result: GeneratedFileResult | null;
  label?: string;
};

/**
 * Reusable file-action card shown after any file is created or exported.
 * Offers Open file (primary), Show in folder (secondary), and Copy path,
 * and falls back to opening the containing directory when needed.
 */
export function GeneratedFileActions({ result, label = 'Generated file' }: FileActionResultProps) {
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [clipboardFailed, setClipboardFailed] = useState(false);

  if (!result?.filePath && !result?.directoryPath) return null;

  const run = async (action: () => Promise<FileActionResult>, name: string, okMessage: string) => {
    setBusy(name);
    setNotice(null);
    const outcome = await action();
    setNotice({ text: outcome.ok ? okMessage : outcome.message, ok: outcome.ok });
    setBusy(null);
  };

  const copyPath = async () => {
    const value = result.filePath ?? result.directoryPath ?? '';
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ text: 'Path copied to clipboard.', ok: true });
    } catch {
      setClipboardFailed(true);
      setNotice({ text: 'Unable to copy the path automatically.', ok: false });
    }
  };

  return (
    <div className="file-result-card" role="status">
      <p className="file-result-label">{label}</p>
      {result.fileName && <p className="file-result-name">{result.fileName}</p>}
      <p className="file-result-path" title={result.filePath ?? result.directoryPath ?? ''}>
        {result.filePath ?? result.directoryPath}
      </p>
      <div className="file-result-actions">
        {result.filePath && (
          <button
            className="admin-button file-action file-action-primary"
            type="button"
            disabled={busy !== null}
            onClick={() => void run(() => openGeneratedFile(result.filePath!), 'open', 'File opened.')}
          >
            {busy === 'open' ? 'Opening…' : <><ExternalLink size={15} /> Open file</>}
          </button>
        )}
        {result.filePath && (
          <button
            className="admin-button file-action"
            type="button"
            disabled={busy !== null}
            onClick={() => void run(() => revealGeneratedFile(result.filePath!), 'reveal', 'File revealed in folder.')}
          >
            {busy === 'reveal' ? 'Revealing…' : <><Search size={15} /> Show in folder</>}
          </button>
        )}
        {!result.filePath && result.directoryPath && (
          <button
            className="admin-button file-action"
            type="button"
            disabled={busy !== null}
            onClick={() => void run(() => openGeneratedDirectory(result.directoryPath!), 'dir', 'Folder opened.')}
          >
            {busy === 'dir' ? 'Opening…' : <><FolderOpen size={15} /> Open folder</>}
          </button>
        )}
        {(result.filePath || result.directoryPath) && (
          <button className="admin-button file-action" type="button" onClick={() => void copyPath()}>
            <Copy size={15} /> Copy path
          </button>
        )}
      </div>
      <p className="file-result-mode">{result.isPortableMode ? 'Portable mode' : 'Installed mode'}</p>
      {clipboardFailed && (
        <div className="clipboard-fallback">
          <p className="reset-hint">Press Ctrl+C to copy:</p>
          <input
            readOnly
            value={result.filePath ?? result.directoryPath ?? ''}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
      {notice && (
        <p className={`file-result-notice${notice.ok ? ' is-success' : ' is-error'}`} role={notice.ok ? 'status' : 'alert'}>
          {notice.ok && <Check size={13} />}
          {notice.text}
        </p>
      )}
    </div>
  );
}
