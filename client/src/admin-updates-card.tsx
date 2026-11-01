import { useEffect, useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import {
  isAutoUpdateDisabledLocally,
  setAutoUpdateDisabledLocally,
} from './services/updateService';
import { getAutostartStatus, setAutostartStatus } from './api';

interface AdminUpdatesCardProps {
  onManualCheck: () => void;
}

/** System's update and startup rows: the installed version beside Check for updates now, then two plain tick boxes. */
export function AdminUpdatesCard({ onManualCheck }: AdminUpdatesCardProps) {
  // The installed version and Windows startup exist only in the desktop app.
  const desktop = '__TAURI_INTERNALS__' in window;
  const [version, setVersion] = useState<string | null>(null);
  const [autoUpdateDisabled, setAutoUpdateDisabled] = useState(() =>
    isAutoUpdateDisabledLocally(),
  );
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartFailed, setAutostartFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void getAutostartStatus().then((enabled) => {
      if (active) setAutostartEnabled(enabled);
    });
    if (desktop) {
      void getVersion()
        .then((installed) => {
          if (active) setVersion(installed);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [desktop]);

  const toggleAutoUpdate = (disabled: boolean) => {
    setAutoUpdateDisabled(disabled);
    setAutoUpdateDisabledLocally(disabled);
  };

  const toggleAutostart = async (enabled: boolean) => {
    setAutostartBusy(true);
    setAutostartFailed(false);
    try {
      // Read the setting back afterwards: the box shows what Windows really has, and a change that didn't take (on or
      // off) says so.
      await setAutostartStatus(enabled);
      const actual = await getAutostartStatus();
      setAutostartEnabled(actual);
      setAutostartFailed(actual !== enabled);
    } finally {
      setAutostartBusy(false);
    }
  };

  return (
    <>
      <div className="system-row">
        <span className="system-version">
          {version ? `Version ${version}` : desktop ? 'Version —' : 'Version: desktop app only'}
        </span>
        <button className="admin-button" type="button" onClick={onManualCheck}>
          <ArrowUpCircle size={15} aria-hidden="true" />
          Check for updates now
        </button>
      </div>
      <label className="voice-toggle-label">
        <input
          type="checkbox"
          checked={!autoUpdateDisabled}
          onChange={(e) => toggleAutoUpdate(!e.target.checked)}
        />
        <span>Check for updates automatically</span>
      </label>
      {autoUpdateDisabled && <p className="reset-hint">Off. Check for updates now still works.</p>}
      <label className="voice-toggle-label">
        <input
          type="checkbox"
          checked={autostartEnabled}
          disabled={!desktop || autostartBusy}
          onChange={(e) => void toggleAutostart(e.target.checked)}
        />
        <span>Open the attendance screen when Windows starts</span>
      </label>
      {!desktop ? (
        <p className="reset-hint">Only in the desktop app.</p>
      ) : (
        autostartFailed && <p className="system-error" role="alert">Couldn&apos;t change the startup setting.</p>
      )}
    </>
  );
}
