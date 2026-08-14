/**
 * Office identity: the single source of truth for the company office shown
 * across the kiosk, admin UI, LAN dashboard, exports, and printed references.
 *
 * The canonical office address is:
 *   Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila
 *
 * `officePostalCode` is optional and configurable only. It is intentionally
 * unset by default because no verified postal code should be hardcoded.
 */

export type OfficeIdentity = {
  companyName: string;
  /** Optional tax identifier shown on printed payroll sheets. */
  taxIdentificationNumber?: string;
  officeLabel: string;
  officeAddressLine1: string;
  officeBuilding: string;
  officeDistrict: string;
  officeCity: string;
  officeRegion: string;
  officeCountry: string;
  /** Optional and configurable only. Leave unset until explicitly confirmed. */
  officePostalCode: string;
  officeDisplayShort: string;
  officeDisplayFull: string;
};

export const DEFAULT_OFFICE_IDENTITY: OfficeIdentity = {
  companyName: 'Alpha Premier Group of Companies OPC.',
  taxIdentificationNumber: '010-871-213-0000',
  officeLabel: 'Main Office',
  officeAddressLine1: 'Unit 3104C',
  officeBuilding: 'Tektite East Tower',
  officeDistrict: 'Ortigas Center',
  officeCity: 'Pasig',
  officeRegion: 'Metro Manila',
  officeCountry: 'Philippines',
  officePostalCode: '',
  officeDisplayShort: 'Tektite East Tower, Ortigas Center, Pasig',
  officeDisplayFull: 'Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila',
};

/** Safe short fallback when no office fields are configured. */
export const OFFICE_FALLBACK_DISPLAY = 'Alpha Premier Office';

export type OfficeDisplayVariant = 'full' | 'short';

/** Join non-empty, trimmed parts with commas; never emits broken comma chains. */
function joinParts(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(', ');
}

/**
 * Compose an address from structured fields.
 * - short: Building, District, City
 * - full: Line 1, Building, District, City [postal], Region
 */
export function composeOfficeAddress(
  identity: Partial<OfficeIdentity> | undefined,
  variant: OfficeDisplayVariant,
): string {
  const source = identity ?? {};
  if (variant === 'full') {
    const city = source.officeCity?.trim() ?? '';
    const postal = source.officePostalCode?.trim() ?? '';
    const cityWithPostal = postal ? (city ? `${city} ${postal}` : postal) : city;
    return joinParts([
      source.officeAddressLine1,
      source.officeBuilding,
      source.officeDistrict,
      cityWithPostal,
      source.officeRegion,
    ]);
  }
  return joinParts([source.officeBuilding, source.officeDistrict, source.officeCity]);
}

/**
 * Resolve the display string for a variant.
 * Fallback order:
 *   1. the configured display string for the variant
 *   2. a composed address from the structured fields
 *   3. the safe short fallback `Alpha Premier Office`
 */
export function resolveOfficeDisplay(
  identity: Partial<OfficeIdentity> | undefined,
  variant: OfficeDisplayVariant,
): string {
  const configured = variant === 'full' ? identity?.officeDisplayFull : identity?.officeDisplayShort;
  const configuredValue = configured?.trim();
  if (configuredValue) return configuredValue;
  const composed = composeOfficeAddress(identity, variant);
  if (composed) return composed;
  return OFFICE_FALLBACK_DISPLAY;
}

export function officeCompanyName(identity: Partial<OfficeIdentity> | undefined): string {
  return identity?.companyName?.trim() || DEFAULT_OFFICE_IDENTITY.companyName;
}

/** Metadata lines used by exports and printed report headers. */
export function officeMetadataLines(
  identity: Partial<OfficeIdentity> | undefined,
): string[] {
  return [
    `Company: ${officeCompanyName(identity)}`,
    `Office: ${resolveOfficeDisplay(identity, 'full')}`,
  ];
}
