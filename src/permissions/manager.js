import path from 'node:path';
import { readFileSync } from 'node:fs';
import { normalizePolicy } from './policy.js';
import { claimPolicyRemoteGeneration, updatePolicy } from './store.js';

export function createPolicyManager(initialPolicy, { filePath } = {}) {
  let policy = normalizePolicy(initialPolicy);
  let hasReadDisk = false;
  const listeners = new Set();

  function authoritative() {
    if (!filePath) return policy;
    try {
      const latest = normalizePolicy(JSON.parse(readFileSync(filePath, 'utf8')));
      hasReadDisk = true;
      if (JSON.stringify(latest) !== JSON.stringify(policy)) {
        policy = latest;
        notify();
      }
    } catch (error) {
      if (error?.code === 'ENOENT' && !hasReadDisk) return policy; // pre-initialization default; no persisted policy yet
      if (error?.code === 'ENOENT') throw Object.assign(new Error('Policy file unavailable during authorization'), { code: 'PERMISSION_POLICY_UNAVAILABLE' });
      throw error;
    }
    return policy;
  }
  function notify() {
    for (const listener of listeners) listener(policy);
  }

  async function mutate(updater, { assertCurrent = () => {}, remoteGeneration } = {}) {
    assertCurrent();
    if (filePath) policy = await updatePolicy(filePath, updater, policy, { assertCurrent, remoteGeneration });
    else {
      const next = normalizePolicy(await updater(policy));
      assertCurrent();
      policy = next;
    }
    hasReadDisk ||= Boolean(filePath);
    notify();
    return policy;
  }

  return {
    get: authoritative,
    claimRemoteGeneration: filePath
      ? async (generation, assertCurrent) => {
          const authoritative = await claimPolicyRemoteGeneration(filePath, generation, assertCurrent);
          // The disk snapshot is read under the SAME generation-claim lock.
          // Publish before announcing device.ready or admitting remote calls.
          policy = normalizePolicy(authoritative);
          notify();
          return policy;
        }
      : null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setCategory(category, action, options = {}) {
      return mutate((current) => normalizePolicy({
        ...current,
        categories: { ...current.categories, [category]: action }
      }), options);
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
