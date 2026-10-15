export const SCOUT_QUERY_TABLES = ['scout_message_queries','scout_query_receipts','scout_query_proposals'];
export const SCOUT_TABLES = ['scout_campaigns','scout_grants','scout_candidates','scout_jobs','scout_samples','scout_assessments','scout_calls','scout_model_requests',...SCOUT_QUERY_TABLES];
export const SCOUT_QUERY_COMMANDS = new Set(['scout.register','scout.query_messages','scout.request_query_assessment','scout.review_query']);
export const SCOUT_COMMANDS = new Set(['scout.create','scout.revise','scout.pause','scout.authorize','scout.seed','scout.search','scout.audit','scout.request_assessment','scout.revoke_assessment','scout.review','scout.admit','scout.revoke',...SCOUT_QUERY_COMMANDS]);
