import React, { useState, useRef, useCallback } from 'react';
import type { UpsertPronunciationRequest } from '@rfid-attendance/shared';

export interface VoiceNameEditorProps {
  employeeId: string;
  initialDisplayName: string;
  fullName: string;
  existingPronunciation?: {
    displayName?: string;
    phoneticSimple?: string;
    phoneticIpa?: string;
    languageTag?: string;
    notes?: string;
  };
  onSave: (saved: UpsertPronunciationRequest) => Promise<void>;
  onCancel: () => void;
}

const IPA_VOWELS = ['i', 'y', 'e', 'ø', 'ɛ', 'a', 'ɶ', 'ɔ', 'o', 'ʊ', 'u', 'ɨ', 'ʉ', 'ə', 'ɐ'];
const IPA_CONSONANTS = [
  'p', 'b', 't', 'd', 'k', 'g', 'm', 'n', 'ŋ', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ', 'h', 'l', 'r', 'ɾ', 'ɹ', 'j', 'w',
];
const IPA_STRESS_SYLLABLES = ['ˈ', 'ˌ', '.', '-'];

const LANGUAGE_TAG_OPTIONS = [
  { value: 'en-PH', label: 'en-PH (English - Philippines)' },
  { value: 'fil-PH', label: 'fil-PH (Filipino / Tagalog)' },
  { value: 'en-US', label: 'en-US (English - United States)' },
  { value: 'en-GB', label: 'en-GB (English - United Kingdom)' },
];

export function VoiceNameEditor({
  employeeId,
  initialDisplayName,
  fullName,
  existingPronunciation,
  onSave,
  onCancel,
}: VoiceNameEditorProps) {
  const [displayName, setDisplayName] = useState(
    existingPronunciation?.displayName ?? initialDisplayName ?? '',
  );
  const [phoneticSimple, setPhoneticSimple] = useState(
    existingPronunciation?.phoneticSimple ?? '',
  );
  const [phoneticIpa, setPhoneticIpa] = useState(
    existingPronunciation?.phoneticIpa ?? '',
  );
  const [languageTag, setLanguageTag] = useState(
    existingPronunciation?.languageTag ?? 'en-PH',
  );
  const [notes, setNotes] = useState(
    existingPronunciation?.notes ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const ipaInputRef = useRef<HTMLInputElement>(null);
  const simpleInputRef = useRef<HTMLInputElement>(null);
  const lastTargetInputRef = useRef<'ipa' | 'simple'>('ipa');

  const insertSymbol = useCallback((char: string) => {
    const isSimpleTarget = lastTargetInputRef.current === 'simple';
    const input = isSimpleTarget ? simpleInputRef.current : ipaInputRef.current;
    const currentVal = isSimpleTarget ? phoneticSimple : phoneticIpa;
    const setter = isSimpleTarget ? setPhoneticSimple : setPhoneticIpa;

    if (!input) {
      setter((prev) => prev + char);
      return;
    }

    const start = input.selectionStart ?? currentVal.length;
    const end = input.selectionEnd ?? currentVal.length;
    const nextVal = currentVal.slice(0, start) + char + currentVal.slice(end);
    setter(nextVal);

    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + char.length, start + char.length);
    });
  }, [phoneticIpa, phoneticSimple]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorMessage(null);

    try {
      await onSave({
        displayName: displayName.trim(),
        phoneticSimple: phoneticSimple.trim(),
        phoneticIpa: phoneticIpa.trim(),
        languageTag: languageTag.trim(),
        notes: notes.trim(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save pronunciation override';
      setErrorMessage(message);
    } finally {
      setSaving(false);
    }
  };

  const syllables = phoneticSimple
    .split(/[-/\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-editor-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel();
      }}
    >
      <div className="setup-dialog voice-editor-dialog" style={{ width: 'min(720px, 96vw)', maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="setup-dialog-header">
          <div>
            <span className="section-kicker">Voicebox Audio Dictionary</span>
            <h2 id="voice-editor-title">Edit Pronunciation: {fullName}</h2>
            <p className="form-help" style={{ margin: '4px 0 0' }}>
              Employee ID: <strong>{employeeId}</strong>
            </p>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={onCancel}
            disabled={saving}
            aria-label="Close dialog"
            style={{ fontSize: '1.2rem', lineHeight: 1 }}
          >
            &times;
          </button>
        </div>

        <form className="setup-form" onSubmit={handleSubmit} style={{ gap: '16px' }}>
          {errorMessage && (
            <div className="banner-message banner-error" role="alert" style={{ marginBottom: '8px' }}>
              {errorMessage}
            </div>
          )}

          {/* Live Preview Box */}
          <div
            className="voice-preview-card"
            style={{
              padding: '14px 16px',
              borderRadius: '6px',
              background: 'var(--surface-input, rgba(255, 255, 255, 0.04))',
              border: '1px solid var(--gold-soft, #c6a25440)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span className="section-kicker" style={{ color: 'var(--gold, #c6a254)' }}>
                Live TTS Audio Preview
              </span>
              <span className="slider-badge" style={{ fontSize: '0.72rem' }}>
                {languageTag || 'en-PH'}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '8px' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--muted, #888)' }}>Spoken Display Name:</div>
                <div style={{ fontWeight: 600, color: 'var(--ink, #fff)', fontSize: '1.05rem' }}>
                  {displayName || initialDisplayName || '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--muted, #888)' }}>Simple Phonetic:</div>
                <div style={{ fontWeight: 600, color: 'var(--gold-bright, #e4c278)', fontSize: '1.05rem' }}>
                  {phoneticSimple || '—'}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--muted, #888)' }}>IPA Transcription:</div>
                <div style={{ fontFamily: 'monospace', color: 'var(--ink, #fff)', fontSize: '0.95rem' }}>
                  {phoneticIpa ? `/${phoneticIpa.replace(/^\/+|\/+$/g, '')}/` : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--muted, #888)', marginBottom: '4px' }}>
                  Syllable Breakdown:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {syllables.length > 0 ? (
                    syllables.map((syl, index) => (
                      <span
                        key={index}
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: '12px',
                          background: 'rgba(198, 162, 84, 0.15)',
                          border: '1px solid var(--gold-soft, #c6a25440)',
                          color: 'var(--gold-bright, #e4c278)',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                        }}
                      >
                        {syl}
                      </span>
                    ))
                  ) : (
                    <span style={{ color: 'var(--muted, #888)', fontSize: '0.8rem' }}>None</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Form Fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label htmlFor="voice-display-name">Spoken Display Name</label>
              <input
                id="voice-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Bea, Carlos"
                disabled={saving}
              />
              <p className="form-help">Preferred spoken first name or nickname.</p>
            </div>

            <div>
              <label htmlFor="voice-language-tag">Language / Accent Tag</label>
              <select
                id="voice-language-tag"
                value={languageTag}
                onChange={(e) => setLanguageTag(e.target.value)}
                disabled={saving}
              >
                {LANGUAGE_TAG_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="form-help">Dialect tag for phoneme synthesis.</p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label htmlFor="voice-phonetic-simple">Simple Phonetic Guide</label>
              <input
                ref={simpleInputRef}
                id="voice-phonetic-simple"
                type="text"
                value={phoneticSimple}
                onChange={(e) => setPhoneticSimple(e.target.value)}
                onFocus={() => {
                  lastTargetInputRef.current = 'simple';
                }}
                placeholder="e.g. BEE-ah, kar-LOHS"
                disabled={saving}
              />
              <p className="form-help">Syllables separated by dashes. Capitalize stressed syllable.</p>
            </div>

            <div>
              <label htmlFor="voice-phonetic-ipa">IPA Transcription</label>
              <input
                ref={ipaInputRef}
                id="voice-phonetic-ipa"
                type="text"
                value={phoneticIpa}
                onChange={(e) => setPhoneticIpa(e.target.value)}
                onFocus={() => {
                  lastTargetInputRef.current = 'ipa';
                }}
                placeholder="e.g. /ˈbiː.ə/, kɑːrˈloʊs"
                disabled={saving}
              />
              <p className="form-help">Standard International Phonetic Alphabet symbols.</p>
            </div>
          </div>

          {/* On-Screen IPA Keyboard */}
          <div
            className="ipa-keyboard-container"
            style={{
              padding: '12px 14px',
              borderRadius: '6px',
              background: 'var(--surface-input, rgba(0, 0, 0, 0.2))',
              border: '1px solid var(--line, #333)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span className="section-kicker" style={{ fontSize: '0.7rem' }}>
                On-Screen IPA &amp; Phonetic Keyboard (Click symbol to insert into IPA transcription)
              </span>
            </div>

            {/* Vowels */}
            <div style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted, #888)', marginBottom: '4px' }}>Vowels</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {IPA_VOWELS.map((char) => (
                  <button
                    key={char}
                    type="button"
                    className="ipa-char-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertSymbol(char)}
                    aria-label={`IPA vowel ${char}`}
                    style={{
                      minWidth: '32px',
                      height: '32px',
                      padding: '0 6px',
                      fontSize: '0.95rem',
                      fontFamily: 'monospace',
                      cursor: 'pointer',
                      borderRadius: '4px',
                      border: '1px solid var(--line-bright, #444)',
                      background: 'var(--surface, #1e1e1e)',
                      color: 'var(--ink, #fff)',
                    }}
                  >
                    {char}
                  </button>
                ))}
              </div>
            </div>

            {/* Consonants */}
            <div style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted, #888)', marginBottom: '4px' }}>Consonants</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {IPA_CONSONANTS.map((char) => (
                  <button
                    key={char}
                    type="button"
                    className="ipa-char-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertSymbol(char)}
                    aria-label={`IPA consonant ${char}`}
                    style={{
                      minWidth: '32px',
                      height: '32px',
                      padding: '0 6px',
                      fontSize: '0.95rem',
                      fontFamily: 'monospace',
                      cursor: 'pointer',
                      borderRadius: '4px',
                      border: '1px solid var(--line-bright, #444)',
                      background: 'var(--surface, #1e1e1e)',
                      color: 'var(--ink, #fff)',
                    }}
                  >
                    {char}
                  </button>
                ))}
              </div>
            </div>

            {/* Stress & Syllables */}
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted, #888)', marginBottom: '4px' }}>
                Stress &amp; Syllable Markers
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {IPA_STRESS_SYLLABLES.map((char) => (
                  <button
                    key={char}
                    type="button"
                    className="ipa-char-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertSymbol(char)}
                    aria-label={`IPA marker ${char}`}
                    style={{
                      minWidth: '32px',
                      height: '32px',
                      padding: '0 6px',
                      fontSize: '0.95rem',
                      fontFamily: 'monospace',
                      cursor: 'pointer',
                      borderRadius: '4px',
                      border: '1px solid var(--gold-soft, #c6a25440)',
                      background: 'rgba(198, 162, 84, 0.1)',
                      color: 'var(--gold-bright, #e4c278)',
                      fontWeight: 'bold',
                    }}
                  >
                    {char}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="voice-notes">Pronunciation Notes (Optional)</label>
            <textarea
              id="voice-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Rhymes with cheer; emphasis on first syllable"
              disabled={saving}
              style={{
                width: '100%',
                minWidth: 0,
                padding: '8px 12px',
                color: 'var(--ink, #fff)',
                background: 'var(--surface-input, rgba(255, 255, 255, 0.05))',
                border: '1px solid var(--line-bright, #444)',
                borderRadius: '3px',
                outline: 'none',
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
            <button
              type="button"
              className="admin-button"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="admin-button file-action-primary"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save Pronunciation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}