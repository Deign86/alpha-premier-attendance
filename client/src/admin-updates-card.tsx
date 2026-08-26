import { useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import {
  isAutoUpdateDisabledLocally,
  setAutoUpdateDisabledLocally,
} from './services/updateService';

interface AdminUpdatesCardProps {
  onManualCheck: () => void;
}

export function AdminUpdatesCard({ onManualCheck }: AdminUpdatesCardProps) {
  const [autoUpdateDisabled, setAutoUpdateDisabled] = useState(() =>
    isAutoUpdateDisabledLocally(),
  );

  const toggleAutoUpdate = (disabled: boolean) => {
    setAutoUpdateDisabled(disabled);
    setAutoUpdateDisabledLocally(disabled);
  };

  return (
    <div className="admin-update-card">
      <div className="admin-update-header">
        <div className="admin-update-info">
          <p className="section-kicker">Software updates</p>
          <h3>Application version &amp; release channel</h3>
          <p>
            Alpha Premier Attendance checks GitHub Releases (
            <code>Deign86/alpha-premier-attendance</code>) for signed updates.
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
