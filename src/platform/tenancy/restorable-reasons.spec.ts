import { RESTORABLE_REVOKE_REASONS } from '../identity/index.js';
import { INSTITUTION_DEACTIVATED } from './institution.service.js';
import { SOCIETY_DEACTIVATED } from './society.service.js';

describe('the grants a reactivation restores', () => {
  it('are the ones revoked when a Society or an Institution is deactivated', () => {
    // The Identity module cannot import these, so it keeps their values (STF-13 counts such grants as held).
    expect([...RESTORABLE_REVOKE_REASONS].toSorted()).toEqual(
      [INSTITUTION_DEACTIVATED, SOCIETY_DEACTIVATED].toSorted(),
    );
  });
});
