export const AUDIENCE_ATTENTION_TABLES = ['audience_attention_grants', 'audience_attention_attempts'];
export const AUDIENCE_SOURCE_EPOCH_TABLES = ['audience_watch_epochs'];
export const AUDIENCE_TABLES = ['audience_goals', 'audience_watches', 'audience_exchanges',
  'audience_assessments', 'audience_needs', 'audience_work_links', ...AUDIENCE_ATTENTION_TABLES, ...AUDIENCE_SOURCE_EPOCH_TABLES];
export const AUDIENCE_ACTIONS = new Set(['audience.open', 'audience.pause', 'audience.capture',
  'audience.propose', 'audience.review', 'audience.review_first_contact', 'audience.open_work', 'audience.refresh_work', 'audience.import_preview',
  'audience.reassess', 'audience.cancel_reassessment', 'audience.retry_reassessment',
  'audience.attention_grant', 'audience.attention_revoke', 'audience.retry_assessment', 'audience.cancel_assessment',
  'audience.followup_request', 'audience.followup_revoke', 'audience.renew_source']);
