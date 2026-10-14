export const PROFILE_ORDER = ['auto', 'readOnly', 'fullAccess', 'custom'];

export const PROFILES = Object.freeze({
  auto: {
    label: 'Auto (base 5)',
    description: 'Preset for the five base categories only; image, cache and browser decisions are independent.',
    categories: { read: 'allow', write: 'allow', command: 'allow', dangerous: 'ask', outsideRoot: 'ask' }
  },
  readOnly: {
    label: 'Read-only (base 5)',
    description: 'Read-only preset for the five base categories only; advanced permissions are unchanged.',
    categories: { read: 'allow', write: 'ask', command: 'ask', dangerous: 'ask', outsideRoot: 'ask' }
  },
  fullAccess: {
    label: 'Allow base 5',
    description: 'Allow all five base categories only; does not automatically allow image, cache or browser access.',
    categories: { read: 'allow', write: 'allow', command: 'allow', dangerous: 'allow', outsideRoot: 'allow' }
  },
  custom: {
    label: 'Custom (base 5)',
    description: 'Base categories differ from presets; all 16 permissions remain individually editable.',
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

// Base presets intentionally never touch the 11 Image/Cache/Browser categories.
// Keep this operation explicit and per-instance; advanced ASK/DENY decisions
// must not become ALLOW merely because a legacy preset was selected.
export async function applyProfile(policyManager, profileKey) {
  const profile = PROFILES[profileKey];
  if (!profile?.categories) return;
  for (const [category, action] of Object.entries(profile.categories)) {
    await policyManager.setCategory(category, action);
  }
}
