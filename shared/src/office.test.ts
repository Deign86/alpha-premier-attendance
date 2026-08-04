import { describe, expect, it } from 'vitest';
import {
  composeOfficeAddress,
  DEFAULT_OFFICE_IDENTITY,
  OFFICE_FALLBACK_DISPLAY,
  officeMetadataLines,
  resolveOfficeDisplay,
} from './office.js';

describe('office identity', () => {
  it('renders the canonical full address from the default identity', () => {
    expect(resolveOfficeDisplay(DEFAULT_OFFICE_IDENTITY, 'full')).toBe(
      'Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila',
    );
  });

  it('renders the canonical short display from the default identity', () => {
    expect(resolveOfficeDisplay(DEFAULT_OFFICE_IDENTITY, 'short')).toBe(
      'Tektite East Tower, Ortigas Center, Pasig',
    );
  });

  it('composes the full address from structured fields when display strings are missing', () => {
    const identity = {
      officeAddressLine1: 'Unit 3104C',
      officeBuilding: 'Tektite East Tower',
      officeDistrict: 'Ortigas Center',
      officeCity: 'Pasig',
      officeRegion: 'Metro Manila',
    };
    expect(resolveOfficeDisplay(identity, 'full')).toBe(
      'Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila',
    );
    expect(resolveOfficeDisplay(identity, 'short')).toBe(
      'Tektite East Tower, Ortigas Center, Pasig',
    );
  });

  it('falls back to Alpha Premier Office when nothing is configured', () => {
    expect(resolveOfficeDisplay({}, 'full')).toBe(OFFICE_FALLBACK_DISPLAY);
    expect(resolveOfficeDisplay(undefined, 'short')).toBe(OFFICE_FALLBACK_DISPLAY);
  });

  it('never emits broken comma chains from empty parts', () => {
    expect(composeOfficeAddress({ officeCity: 'Pasig', officeRegion: 'Metro Manila' }, 'full')).toBe(
      'Pasig, Metro Manila',
    );
    expect(composeOfficeAddress({ officeRegion: 'Metro Manila' }, 'short')).toBe('');
    expect(resolveOfficeDisplay({ officeRegion: 'Metro Manila' }, 'short')).toBe(
      OFFICE_FALLBACK_DISPLAY,
    );
  });

  it('includes the postal code in the full address only when configured', () => {
    const withPostal = { ...DEFAULT_OFFICE_IDENTITY, officeDisplayFull: '', officePostalCode: '1600' };
    expect(resolveOfficeDisplay(withPostal, 'full')).toBe(
      'Unit 3104C, Tektite East Tower, Ortigas Center, Pasig 1600, Metro Manila',
    );
    expect(resolveOfficeDisplay(DEFAULT_OFFICE_IDENTITY, 'full')).not.toContain('1600');
    expect(DEFAULT_OFFICE_IDENTITY.officePostalCode).toBe('');
  });

  it('prefers the configured display strings over composed values', () => {
    const identity = {
      officeBuilding: 'Old Building',
      officeCity: 'Makati',
      officeDisplayShort: 'Tektite East Tower, Ortigas Center, Pasig',
      officeDisplayFull: 'Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila',
    };
    expect(resolveOfficeDisplay(identity, 'short')).toBe(
      'Tektite East Tower, Ortigas Center, Pasig',
    );
    expect(resolveOfficeDisplay(identity, 'full')).toBe(
      'Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila',
    );
  });

  it('builds clean Company/Office metadata lines', () => {
    expect(officeMetadataLines(DEFAULT_OFFICE_IDENTITY)).toEqual([
      'Company: Alpha Premier',
      'Office: Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila',
    ]);
    expect(officeMetadataLines(undefined)).toEqual([
      'Company: Alpha Premier',
      'Office: Alpha Premier Office',
    ]);
  });
});
