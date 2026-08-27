import { useEffect, useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import {
  isAutoUpdateDisabledLocally,
  setAutoUpdateDisabledLocally,
} from './services/updateService';
import { getAutostartStatus, setAutostartStatus } from './api';

interface AdminUpdatesCardProps {
  onManualCheck: () => void;
}

export function AdminUpdatesCard({ onManualCheck }: AdminUpdatesCardProps) {
  const [autoUpdateDisabled, setAutoUpdateDisabled] = useState(() =>
    isAutoUpdateDisabledLocally(),
  );
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void getAutostartStatus().then((enabled) => {
      if (active) setAutostartEnabled(enabled);
    });
    return () => {
      active = false;
    };
  }, []);

  const toggleAutoUpdate = (disabled: boolean) => {
    setAutoUpdateDisabled(disabled);
    setAutoUpdateDisabledLocally(disabled);
  };

  const toggleAutostart = async (enabled: boolean) => {
    setAutostartBusy(true);
    try {
      const next = await setAutostartStatus(enabled);
      setAutostartEnabled(next);
    } finally {
      setAutostartBusy(false);
    }
  };

  return (
    <div className="admin-update-card">
      <div className="admin-update-header">
        <div className="admin-update-info">
          <p className="section-kicker">Software updates &amp; System</p>
          <h3>Application version &amp; release channel</h3>
          <p>
            Alpha Premier Attendance checks GitHub Releases (
            <code>Deign86/alpha-premier-attendance</code>) for signed updates and configures system startup behavior.
          </p>
        </div>
        <button
          className="admin-button"
          type="button"
          onClick={onManualCheck}
        >
          <ArrowUpCircle size={16} />
          Check for updates now
        </button>
      </div>

      <div className="admin-update-controls">
        <label className="voice-toggle-label">
          <input
            type="checkbox"
            checked={autostartEnabled}
            disabled={autostartBusy}
            onChange={(e) => void toggleAutostart(e.target.checked)}
          />
          <span>Start Alpha Premier Attendance automatically on Windows startup</span>
        </label>
        <p className="reset-hint" style={{ width: '100%', margin: '0' }}>
          {autostartEnabled
            ? 'The application starts automatically in kiosk mode when Windows logs in.'
            : 'Automatic startup is currently turned off. You can also toggle this from the system tray menu.'}
        </p>

        <label className="voice-toggle-label" style={{ marginTop: '8px' }}>
          <input
            type="checkbox"
            checked={!autoUpdateDisabled}
            onChange={(e) => toggleAutoUpdate(!e.target.checked)}
          />
          <span>Automatically check for updates on this kiosk terminal</span>
        </label>
        {autoUpdateDisabled && (
          <p className="reset-hint" style={{ width: '100%', margin: '0' }}>
            Automatic background checks are disabled for this kiosk terminal. Manual
            update checks from the admin panel and system tray remain active.
          </p>
        )}
      </div>
    </div>
  );
}
