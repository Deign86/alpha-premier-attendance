import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// The Rust engine owns shared/payroll-fixtures.json. A changed byte means the
// golden contract changed: regenerate it from the real engine, review the diff,
// then update this pin together with PINNED_SHA256 in src-tauri/tests/cutoff_freeze.rs.
const PINNED_SHA256 = 'd501d4332adb3a701b59a02849f6286b30ee8594e4ad5b45a90e844680a7cba6';

describe('Rust-owned payroll golden fixture', () => {
  it('pins fixture bytes after CRLF-to-LF normalization only', async () => {
    const bytes = await readFile(new URL('../payroll-fixtures.json', import.meta.url), 'utf8');
    const normalized = bytes.replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(normalized, 'utf8').digest('hex')).toBe(PINNED_SHA256);
  });
});
