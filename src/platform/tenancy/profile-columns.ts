import type { Phone } from '../../common/validation/phone.dto.js';

/** `email` and `phone` as table columns: an omitted field is left out, `null` clears it. */
export function contactColumns(contact: { email?: string | null; phone?: Phone | null }) {
  const columns: {
    email?: string | null;
    country_code?: string | null;
    phone_number?: string | null;
  } = {};
  if (contact.email !== undefined) columns.email = contact.email?.toLowerCase() ?? null;
  if (contact.phone !== undefined) {
    columns.country_code = contact.phone?.countryCode ?? null;
    columns.phone_number = contact.phone?.number ?? null;
  }
  return columns;
}

interface AddressInput {
  line1?: string | null;
  line2?: string | null;
  pincode?: string | null;
}

/** The address as table columns. It is replaced as a whole (API design 10.4b), so a missing part becomes `null`. */
export function addressColumns(address: AddressInput & { line1: string }): {
  address_line_1: string;
  address_line_2: string | null;
  pincode: string | null;
};
export function addressColumns(address: AddressInput | null): {
  address_line_1: string | null;
  address_line_2: string | null;
  pincode: string | null;
};
export function addressColumns(address: AddressInput | null) {
  return {
    address_line_1: address?.line1 ?? null,
    address_line_2: address?.line2 ?? null,
    pincode: address?.pincode ?? null,
  };
}
