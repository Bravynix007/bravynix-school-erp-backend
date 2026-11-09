export { IdentityNumbersModule } from './identity-numbers.module.js';
export {
  IdentityNumbers,
  REVEAL_LIMIT_PER_DAY,
  REVEAL_REASON_LENGTH,
  requireRevealReason,
  type IdentitySlot,
  type IdentityTable,
  type ProtectedAadhaar,
  type RevealRequest,
} from './identity-numbers.service.js';
export { maskAadhaar, normaliseAadhaar } from './aadhaar.js';
