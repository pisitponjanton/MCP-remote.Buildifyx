export const PROFILE_ORDER = ['auto', 'readOnly', 'fullAccess', 'custom'];

export const PROFILES = Object.freeze({
  auto: {
    label: 'Auto',
    description: 'Read, edit and normal commands automatically; ask for dangerous or outside-workspace access.',
    categories: { read: 'allow', write: 'allow', command: 'allow', dangerous: 'ask', outsideRoot: 'ask' }
  },
  readOnly: {
    label: 'Read only',
    description: 'Read automatically; ask before writes or commands.',
    categories: { read: 'allow', write: 'ask', command: 'ask', dangerous: 'ask', outsideRoot: 'ask' }
  },
  fullAccess: {
    label: 'Allow all',
    description: 'Allow configured tools, dangerous actions and outside-workspace access without asking.',
    categories: { read: 'allow', write: 'allow', command: 'allow', dangerous: 'allow', outsideRoot: 'allow' }
  },
  custom: {
    label: 'Custom',
    description: 'Tune each permission category individually.',
    categories: null
  }
});

export function detectProfile(policy) {
  for (const key of ['auto', 'readOnly', 'fullAccess']) {
    const expected = PROFILES[key].categories;
    if (Object.entries(expected).every(([name, value]) => policy.categories[name] === value)) return key;
  }
  return 'custom';
}
