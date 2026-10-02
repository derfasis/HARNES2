export function validateControl(config) {
  for (const [name, keys] of [['workspace',['enabled','modelEnabled']], ['controlPlane',['enabled','maxConcurrent','reservationUsd']]]) {
    const p = config[name]; if (p === undefined) continue;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k)) || typeof p.enabled !== 'boolean') throw new Error(`Invalid ${name}`);
  }
  const c = config.controlPlane;
  if (c && (!Number.isInteger(c.maxConcurrent) || c.maxConcurrent < 2 || c.maxConcurrent > 4 || typeof c.reservationUsd !== 'number' || !Number.isFinite(c.reservationUsd) || c.reservationUsd <= 0 || c.reservationUsd > 100)) throw new Error('Invalid controlPlane limits');
  const w = config.workspace;
  if (w && (typeof w.modelEnabled !== 'boolean' || w.modelEnabled && !w.enabled || w.enabled && (c?.enabled !== true || config.continuity?.enabled !== true || config.actions?.enabled !== true || config.opportunity?.automatic !== true))) throw new Error('Workspace requires Control Plane, Continuity, local Actions and public observation');
  if (w?.modelEnabled === true && c.maxConcurrent < 3) throw new Error('Model-enabled Workspace requires a slot for each of public, private and work planes');
  if (c?.enabled === true && config.telegram.liveSending !== false) throw new Error('Control Plane v1 requires live sending off');
  return config;
}
