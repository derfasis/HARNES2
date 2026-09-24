// Offline-only isolation of the existing optional AJV-backed opportunity slice.
// No validation/Store/BusinessService/EngagementLoop/delivery code is replaced.
// Run with HARNES_ENGAGEMENT_ISOLATED=1 and --experimental-test-module-mocks
// only when the pinned production dependencies are unavailable.
import { mock } from 'node:test';
if(process.env.HARNES_ENGAGEMENT_ISOLATED==='1') {
  const forbidden=()=>{throw new Error('Optional opportunity path is outside isolated engagement tests');};
  mock.module('../../business/opportunity-consumer.mjs',{namedExports:{captureOpportunity:forbidden,consumeOpportunity:forbidden,opportunityCapture:forbidden,opportunityDetail:forbidden,OPPORTUNITY_TASK:'opportunity_review'}});
  mock.module('../../business/opportunity-pipeline.mjs',{namedExports:{processSourceOpportunity:forbidden}});
  // Discovery is disabled in this dependency-limited Engagement suite; keep its state/permission code real.
  mock.module('../../business/discovery-projection.mjs',{namedExports:{discoverySchema:{},discoveryInstructions:'',discoveryEvidence:forbidden,parseDiscoveryOutput:forbidden}});
}
export const {BusinessService}=await import('../../business/service.mjs');
export const {Scheduler}=await import('../../business/scheduler.mjs');
export const {contextFor}=await import('../../business/context.mjs');
export const {Store,id}=await import('../../business/store.mjs');
