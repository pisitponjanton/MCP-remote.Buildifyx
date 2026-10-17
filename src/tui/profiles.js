import { DEFAULT_POLICY } from '../permissions/policy.js';

export const PROFILE_ORDER = ['auto', 'readOnly', 'fullAccess', 'allowAll', 'custom'];

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
  allowAll: {
    label: 'Allow All (16)',
    description: 'Explicitly allow all 16 permission categories, including image, cache and browser operations.',
    categories: Object.fromEntries(Object.keys(DEFAULT_POLICY.categories).map((key) => [key, 'allow']))
  },
  custom: {
    label: 'Custom',
    description: 'Permission categories differ from presets; all 16 permissions remain individually editable.',
    categories: null
  }
});

export function detectProfile(policy) {
  // Check all 16 before base-only presets; otherwise Allow All looks like Allow base 5.
  for (const key of ['allowAll', 'auto', 'readOnly', 'fullAccess']) {
    const expected = PROFILES[key].categories;
    if (Object.entries(expected).every(([name, value]) => policy.categories[name] === value)) return key;
  }
  return 'custom';
}

// Base presets intentionally leave the 11 Image/Cache/Browser categories unchanged.
// Only the explicit allowAll preset grants all 16 categories, per instance.
export async function applyProfile(policyManager, profileKey) {
  const profile = PROFILES[profileKey];
  if (!profile?.categories) return;
  if (typeof policyManager.setCategories === 'function') {
    await policyManager.setCategories(profile.categories);
  } else {
    for (const [category, action] of Object.entries(profile.categories)) {
      await policyManager.setCategory(category, action);
    }
  }
}
