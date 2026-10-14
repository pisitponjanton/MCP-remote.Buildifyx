export const Decision = Object.freeze({
  ALLOW: 'allow',
  ASK: 'ask',
  DENY: 'deny'
});

export const DEFAULT_POLICY = Object.freeze({
  categories: {
    read: Decision.ALLOW,
    write: Decision.ALLOW,
    command: Decision.ALLOW,
    dangerous: Decision.ASK,
    outsideRoot: Decision.ASK,
    imageRead: Decision.ASK,
    imageSave: Decision.ASK,
    cacheManage: Decision.ASK,
    browserRead: Decision.ASK,
    browserNavigate: Decision.ASK,
    browserInteract: Decision.ASK,
    persistentProfile: Decision.ASK,
    browserCapture: Decision.ASK,
    browserDiagnostics: Decision.ASK,
    browserSensitive: Decision.ASK,
    browserExternal: Decision.ASK
  },
  additionalRoots: [],
  commandRules: []
});

export function normalizePolicy(policy = {}) {
  return {
    categories: {
      ...DEFAULT_POLICY.categories,
      ...(policy.categories ?? {})
    },
    additionalRoots: Array.isArray(policy.additionalRoots) ? [...policy.additionalRoots] : [],
    commandRules: Array.isArray(policy.commandRules) ? policy.commandRules.map((rule) => ({ ...rule })) : []
  };
}
