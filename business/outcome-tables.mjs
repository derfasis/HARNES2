// The vocabulary of a business outcome, and the tables that hold the claim about one.
//
// Kept in one place because two modules now have to agree on it: the manual `outcome.record`
// path has always validated a kind, and the feedback loop promotes a candidate using the same
// list. A candidate whose kind could be promoted under a rule the manual path would have refused
// would be a back door around that refusal.
export const OUTCOME_KINDS = Object.freeze(['qualified','call_proposed','call_accepted','call_booked',
  'call_attended','no_show','joined','declined','business_value']);

export const OUTCOME_TABLES = ['outcome_candidates', 'outcome_observation_windows'];

export const OUTCOME_COMMANDS = new Set(['outcome.candidate_confirm', 'outcome.candidate_reject',
  'outcome.candidate_list']);

// A candidate is an observation, and none of these is an outcome kind. Keeping the two lists
// disjoint is what makes "promote" a decision an operator makes rather than a string match that
// happens to be available.
export const OUTCOME_CANDIDATE_KINDS = Object.freeze(['reply_observed','reaction_observed',
  'no_response_observed','engagement_closed','owner_booking_claimed','owner_outcome_stated']);
