import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { VoiceboxNameListItem, UpsertPronunciationRequest } from '@rfid-attendance/shared';
import { loadVoiceboxNames, saveVoiceboxPronunciation } from './api';
import { VoiceNameEditor } from './voice-name-editor';

export interface VoiceboxNamesPageProps {
  onBack?: () => void;
}

type FilterTab = 'all' | 'configured' | 'missing';

export function VoiceboxNamesPage({ onBack }: VoiceboxNamesPageProps) {
  const [names, setNames] = useState<VoiceboxNameListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [editingItem, setEditingItem] = useState<VoiceboxNameListItem | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const fetchNames = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await loadVoiceboxNames();
      if (res.success) {
        setNames(res.names);
      } else {
        setError(res.error?.message ?? 'Failed to load Voicebox names');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error loading Voicebox names');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchNames();
  }, [fetchNames]);

  const handleSavePronunciation = async (saved: UpsertPronunciationRequest) => {
    if (!editingItem) return;

    const res = await saveVoiceboxPronunciation(editingItem.employeeId, saved);
    if (!res.success) {
      throw new Error(res.error?.message ?? 'Failed to save pronunciation');
    }

    // Update locally so UI responds instantly
    const savedRecord = res.pronunciation || res.record;
    setNames((prev) =>
      prev.map((item) => {
        if (item.employeeId !== editingItem.employeeId) return item;
        const newDisp = savedRecord?.displayName || saved.displayName || item.displayName;
        const newSimple = savedRecord?.phoneticSimple !== undefined ? savedRecord.phoneticSimple : (saved.phoneticSimple ?? item.phoneticSimple);
        const newIpa = savedRecord?.phoneticIpa !== undefined ? savedRecord.phoneticIpa : (saved.phoneticIpa ?? item.phoneticIpa);
        return {
          ...item,
          displayName: newDisp,
          hasPronunciation: Boolean(newSimple || newIpa),
          phoneticSimple: newSimple,
          phoneticIpa: newIpa,
          languageTag: savedRecord?.languageTag ?? saved.languageTag ?? item.languageTag,
          notes: savedRecord?.notes ?? saved.notes ?? item.notes,
        };
      }),
    );

    setEditingItem(null);
    setToastMessage(`Saved pronunciation for ${saved.displayName || editingItem.fullName}.`);

    setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  };

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else if ('window' in globalThis) {
      if (window.location.hash === '#/voicebox-names') {
        window.location.hash = '';
      } else {
        window.location.pathname = '/admin';
      }
    }
  };

  const filteredNames = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return names.filter((item) => {
      const matchesSearch =
        !q ||
        item.fullName.toLowerCase().includes(q) ||
        item.displayName.toLowerCase().includes(q) ||
        item.employeeId.toLowerCase().includes(q);

      if (!matchesSearch) return false;

      if (filterTab === 'configured') return item.hasPronunciation;
      if (filterTab === 'missing') return !item.hasPronunciation;
      return true;
    });
  }, [names, searchQuery, filterTab]);

  const configuredCount = useMemo(() => names.filter((n) => n.hasPronunciation).length, [names]);
  const missingCount = useMemo(() => names.filter((n) => !n.hasPronunciation).length, [names]);

  return (
    <div className="admin-shell voicebox-names-shell" style={{ padding: '24px 32px', minHeight: '100vh' }}>
      {/* Top Header */}
      <header className="admin-header" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            type="button"
            className="admin-button"
            onClick={handleBack}
            aria-label="Back to Admin"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            &larr; Back
          </button>
          <div>
            <span className="section-kicker">Voice Synthesis Overrides</span>
            <h1 style={{ margin: '2px 0 0', fontFamily: 'Orbitron, sans-serif', fontSize: '1.4rem' }}>
              Voicebox Name Pronunciations
            </h1>
            <p className="form-help" style={{ margin: '4px 0 0' }}>
              Manage pronunciation overrides and phonetic dictionaries for TTS name playback from apgbackup.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="button"
            className="admin-button"
            onClick={() => void fetchNames()}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Toast Notification */}
      {toastMessage && (
        <div
          className="banner-message banner-success"
          role="status"
          style={{
            marginBottom: '16px',
            padding: '10px 16px',
            borderRadius: '4px',
            background: 'rgba(82, 196, 126, 0.15)',
            border: '1px solid rgba(82, 196, 126, 0.4)',
            color: 'var(--success, #52c47e)',
          }}
        >
          {toastMessage}
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div
          className="banner-message banner-error"
          role="alert"
          style={{
            marginBottom: '16px',
            padding: '10px 16px',
            borderRadius: '4px',
            background: 'rgba(239, 170, 146, 0.15)',
            border: '1px solid rgba(239, 170, 146, 0.4)',
            color: 'var(--danger, #efaa92)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => void fetchNames()}
            style={{ textDecoration: 'underline' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Search and Filter Controls */}
      <section
        className="kiosk-card"
        style={{
          padding: '16px 20px',
          marginBottom: '20px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '16px',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        {/* Search Bar */}
        <div style={{ flex: '1 1 300px', minWidth: '240px' }}>
          <label htmlFor="voice-search-input" className="sr-only" style={{ display: 'none' }}>
            Search names
          </label>
          <input
            id="voice-search-input"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by full name, display name, or employee ID…"
            style={{
              width: '100%',
              height: '42px',
              padding: '0 14px',
              color: 'var(--ink, #fff)',
              background: 'var(--surface-input, rgba(255, 255, 255, 0.04))',
              border: '1px solid var(--line-bright, #444)',
              borderRadius: '4px',
              outline: 'none',
            }}
          />
        </div>

        {/* Filter Tabs / Segmented Buttons */}
        <div
          className="segmented-control"
          role="tablist"
          aria-label="Filter pronunciations"
          style={{ display: 'flex', gap: '4px', background: 'var(--surface-input, rgba(0, 0, 0, 0.3))', padding: '4px', borderRadius: '6px' }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === 'all'}
            className={`segmented-button ${filterTab === 'all' ? 'active' : ''}`}
            onClick={() => setFilterTab('all')}
            style={{
              padding: '6px 14px',
              borderRadius: '4px',
              border: 'none',
              background: filterTab === 'all' ? 'var(--gold, #c6a254)' : 'transparent',
              color: filterTab === 'all' ? '#111' : 'var(--muted, #aaa)',
              fontWeight: filterTab === 'all' ? 600 : 400,
              cursor: 'pointer',
              fontSize: '0.82rem',
            }}
          >
            All ({names.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === 'configured'}
            className={`segmented-button ${filterTab === 'configured' ? 'active' : ''}`}
            onClick={() => setFilterTab('configured')}
            style={{
              padding: '6px 14px',
              borderRadius: '4px',
              border: 'none',
              background: filterTab === 'configured' ? 'var(--gold, #c6a254)' : 'transparent',
              color: filterTab === 'configured' ? '#111' : 'var(--muted, #aaa)',
              fontWeight: filterTab === 'configured' ? 600 : 400,
              cursor: 'pointer',
              fontSize: '0.82rem',
            }}
          >
            Configured ({configuredCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === 'missing'}
            className={`segmented-button ${filterTab === 'missing' ? 'active' : ''}`}
            onClick={() => setFilterTab('missing')}
            style={{
              padding: '6px 14px',
              borderRadius: '4px',
              border: 'none',
              background: filterTab === 'missing' ? 'var(--gold, #c6a254)' : 'transparent',
              color: filterTab === 'missing' ? '#111' : 'var(--muted, #aaa)',
              fontWeight: filterTab === 'missing' ? 600 : 400,
              cursor: 'pointer',
              fontSize: '0.82rem',
            }}
          >
            Missing ({missingCount})
          </button>
        </div>
      </section>

      {/* Table Listing */}
      <section className="kiosk-card" style={{ padding: '0', overflow: 'hidden' }}>
        <div className="table-wrap">
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line, #333)', background: 'rgba(255, 255, 255, 0.02)' }}>
                <th style={{ padding: '14px 16px', fontSize: '0.78rem', color: 'var(--muted, #aaa)' }}>Employee ID</th>
                <th style={{ padding: '14px 16px', fontSize: '0.78rem', color: 'var(--muted, #aaa)' }}>Full Name</th>
                <th style={{ padding: '14px 16px', fontSize: '0.78rem', color: 'var(--muted, #aaa)' }}>Display Name</th>
                <th style={{ padding: '14px 16px', fontSize: '0.78rem', color: 'var(--muted, #aaa)' }}>Status</th>
                <th style={{ padding: '14px 16px', fontSize: '0.78rem', color: 'var(--muted, #aaa)' }}>Simple Phonetic</th>
                <th style={{ padding: '14px 16px', fontSize: '0.78rem', color: 'var(--muted, #aaa)' }}>IPA Transcription</th>
                <th style={{ padding: '14px 16px', fontSize: '0.78rem', color: 'var(--muted, #aaa)', textAlign: 'right' }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--muted, #888)' }}>
                    Loading Voicebox names…
                  </td>
                </tr>
              ) : filteredNames.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--muted, #888)' }}>
                    {searchQuery ? 'No employees match your search criteria.' : 'No employees found.'}
                  </td>
                </tr>
              ) : (
                filteredNames.map((item) => (
                  <tr
                    key={item.employeeId}
                    style={{ borderBottom: '1px solid var(--line, #282828)' }}
                  >
                    <td style={{ padding: '14px 16px', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                      {item.employeeId}
                    </td>
                    <td style={{ padding: '14px 16px', fontWeight: 600 }}>
                      {item.fullName}
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <span style={{ color: 'var(--gold-bright, #e4c278)', fontWeight: 500 }}>
                        {item.displayName}
                      </span>
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      {item.hasPronunciation ? (
                        <span
                          className="badge badge-ontime"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '3px 8px',
                            borderRadius: '12px',
                            fontSize: '0.72rem',
                            fontWeight: 600,
                          }}
                        >
                          Configured
                        </span>
                      ) : (
                        <span
                          className="badge"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            padding: '3px 8px',
                            borderRadius: '12px',
                            fontSize: '0.72rem',
                            color: 'var(--muted, #888)',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid var(--line, #333)',
                          }}
                        >
                          Missing
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '14px 16px', fontFamily: item.phoneticSimple ? 'inherit' : 'monospace' }}>
                      {item.phoneticSimple || '—'}
                    </td>
                    <td style={{ padding: '14px 16px', fontFamily: 'monospace' }}>
                      {item.phoneticIpa ? `/${item.phoneticIpa.replace(/^\/+|\/+$/g, '')}/` : '—'}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                      <button
                        type="button"
                        className="admin-button"
                        onClick={() => setEditingItem(item)}
                        style={{ padding: '6px 14px', fontSize: '0.8rem' }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Editor Modal */}
      {editingItem && (
        <VoiceNameEditor
          employeeId={editingItem.employeeId}
          initialDisplayName={editingItem.displayName}
          fullName={editingItem.fullName}
          existingPronunciation={{
            displayName: editingItem.displayName,
            phoneticSimple: editingItem.phoneticSimple ?? undefined,
            phoneticIpa: editingItem.phoneticIpa ?? undefined,
            languageTag: editingItem.languageTag ?? undefined,
            notes: editingItem.notes ?? undefined,
          }}
          onSave={handleSavePronunciation}
          onCancel={() => setEditingItem(null)}
        />
      )}
    </div>
  );
}
