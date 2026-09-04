import path from 'node:path';
import { normalizePolicy } from './policy.js';
import { updatePolicy } from './store.js';

export function createPolicyManager(initialPolicy, { filePath } = {}) {
  let policy = normalizePolicy(initialPolicy);
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener(policy);
  }

  async function mutate(updater) {
    if (filePath) policy = await updatePolicy(filePath, updater, policy);
    else policy = normalizePolicy(await updater(policy));
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
      return mutate((current) => normalizePolicy({
        ...current,
        categories: { ...current.categories, [category]: action }
      }));
    },
    async addCommandRule(rule) {
      const normalized = {
        executable: rule.executable,
        argsPrefix: Array.isArray(rule.argsPrefix) ? rule.argsPrefix : [],
        action: rule.action ?? 'ask'
      };
      return mutate((current) => {
        const commandRules = current.commandRules.filter((item) =>
          !(item.executable === normalized.executable && JSON.stringify(item.argsPrefix ?? []) === JSON.stringify(normalized.argsPrefix))
        );
        commandRules.push(normalized);
        return normalizePolicy({ ...current, commandRules });
      });
    },
    async removeCommandRule(index) {
      const target = policy.commandRules[index];
      if (!target) return policy;
      return mutate((current) => normalizePolicy({
        ...current,
        commandRules: current.commandRules.filter((item) =>
          !(item.executable === target.executable && JSON.stringify(item.argsPrefix ?? []) === JSON.stringify(target.argsPrefix ?? []))
        )
      }));
    },
    async removeCommandRuleByMatch({ executable, argsPrefix = [] }) {
      const normalizedPrefix = Array.isArray(argsPrefix) ? argsPrefix : [];
      return mutate((current) => normalizePolicy({
        ...current,
        commandRules: current.commandRules.filter((item) =>
          !(item.executable === executable && JSON.stringify(item.argsPrefix ?? []) === JSON.stringify(normalizedPrefix))
        )
      }));
    },
    async addRoot(root) {
      const absolute = path.resolve(root);
      return mutate((current) => normalizePolicy({
        ...current,
        additionalRoots: [...new Set([...current.additionalRoots, absolute])]
      }));
    },
    async removeRoot(index) {
      const target = policy.additionalRoots[index];
      if (!target) return policy;
      return mutate((current) => normalizePolicy({
        ...current,
        additionalRoots: current.additionalRoots.filter((item) => item !== target)
      }));
    },
    async removeRootByPath(root) {
      const absolute = path.resolve(root);
      return mutate((current) => normalizePolicy({
        ...current,
        additionalRoots: current.additionalRoots.filter((item) => path.resolve(item) !== absolute)
      }));
    }
  };
}
