import path from 'node:path';
import { normalizePolicy } from './policy.js';
import { savePolicy } from './store.js';

export function createPolicyManager(initialPolicy, { filePath } = {}) {
  let policy = normalizePolicy(initialPolicy);
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener(policy);
  }

  async function persist() {
    policy = await savePolicy(policy, filePath);
    notify();
    return policy;
  }

  return {
    get: () => policy,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setCategory(category, action) {
      policy = normalizePolicy({ ...policy, categories: { ...policy.categories, [category]: action } });
      return persist();
    },
    async addCommandRule(rule) {
      const normalized = {
        executable: rule.executable,
        argsPrefix: Array.isArray(rule.argsPrefix) ? rule.argsPrefix : [],
        action: rule.action ?? 'ask'
      };
      const commandRules = policy.commandRules.filter((item) =>
        !(item.executable === normalized.executable && JSON.stringify(item.argsPrefix ?? []) === JSON.stringify(normalized.argsPrefix))
      );
      commandRules.push(normalized);
      policy = normalizePolicy({ ...policy, commandRules });
      return persist();
    },
    async removeCommandRule(index) {
      policy = normalizePolicy({ ...policy, commandRules: policy.commandRules.filter((_, current) => current !== index) });
      return persist();
    },
    async addRoot(root) {
      const absolute = path.resolve(root);
      const additionalRoots = [...new Set([...policy.additionalRoots, absolute])];
      policy = normalizePolicy({ ...policy, additionalRoots });
      return persist();
    },
    async removeRoot(index) {
      policy = normalizePolicy({ ...policy, additionalRoots: policy.additionalRoots.filter((_, current) => current !== index) });
      return persist();
    }
  };
}
