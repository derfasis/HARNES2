// Project current durable authority into the existing source contract. Never mutate config.
export function validateScout(config) {
 const s = config.scout;
 if (s === undefined) return config;
 if (!s || Object.keys(s).some(k => !['enabled','modelEnabled','maxRequestsPerDay','maxRequestsPerSourceDay','maxMessagesPerAudit','maxCandidates','maxModelRunsPerDay','auditMaxAgeSeconds'].includes(k))
   || typeof s.enabled !== 'boolean' || typeof s.modelEnabled !== 'boolean') throw new Error('Invalid scout configuration');
 for (const [key,min,max] of [['maxRequestsPerDay',1,100000],['maxRequestsPerSourceDay',1,10000],['maxMessagesPerAudit',50,1500],['maxCandidates',1,100],['maxModelRunsPerDay',1,100],['auditMaxAgeSeconds',60,604800]])
   if (!Number.isInteger(s[key]) || s[key]<min || s[key]>max) throw new Error(`Invalid scout.${key}`);
 if (s.modelEnabled && (!s.enabled || config.controlPlane?.enabled !== true || config.opportunity?.automatic !== true)) throw new Error('Scout model requires explicit public Control Plane admission');
 if (s.enabled && (config.controlPlane?.enabled !== true || config.telegram?.transport!=='mtproto' || config.telegram?.liveSending !== false)) throw new Error('Scout requires MTProto, Control Plane and no outbound');
 return config;
}
export function effectiveSourceConfig(service) {
 const cfg = service.config;
 const dynamic = service.scout?.monitorPolicies?.() ?? [];
 if (!dynamic.length) return cfg;
 const statics = cfg.opportunity?.telegramSources ?? [];
 const known = new Set(statics.map(p=>p.sourceId));
 const additions = dynamic.filter(p=>!known.has(p.sourceId));
 return {...cfg, opportunity:{...cfg.opportunity, telegramSources:[...statics,...additions],
   allowedSourceRefs:[...new Set([...(cfg.opportunity?.allowedSourceRefs??[]),...additions.map(p=>p.sourceId)])]}};
}
