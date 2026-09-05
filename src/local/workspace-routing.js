function normalize(value) {
  return value?.trim().toLowerCase() ?? '';
}

function matchesDevice(target, selector) {
  if (!selector) return true;
  const needle = normalize(selector);
  if (needle === 'local') return true;
  return normalize(target.deviceId) === needle || normalize(target.deviceName) === needle;
}

function matchesWorkspace(target, selector) {
  if (!selector) return true;
  const needle = normalize(selector);
  return normalize(target.targetId) === needle
    || normalize(target.instanceId) === needle
    || normalize(target.name) === needle
    || normalize(target.path) === needle;
}

export function selectedTarget(target) {
  return { targetId: target.targetId, deviceId: target.deviceId, instanceId: target.instanceId };
}

export function resolveWorkspaceTarget(targets, selector = {}) {
  if (!targets.length) {
    throw Object.assign(new Error('No local Buildifyx workspace is online.'), { code: 'DEVICE_OFFLINE' });
  }

  const targetId = selector.targetId?.trim();
  if (targetId) {
    const target = targets.find((item) => normalize(item.targetId) === normalize(targetId));
    if (target) return target;
    throw Object.assign(new Error(`Target "${targetId}" is not online.`), { code: 'WORKSPACE_NOT_FOUND' });
  }

  const workspace = selector.workspace?.trim();
  const device = selector.device?.trim();
  if (!workspace && !device) {
    if (targets.length === 1) return targets[0];
    throw Object.assign(new Error(
      `Multiple local workspaces are online: ${targets.map((target) => target.name).join(', ')}. Call list_workspaces or use use_workspace first.`
    ), { code: 'WORKSPACE_SELECTION_REQUIRED' });
  }

  const matches = targets.filter((target) => matchesDevice(target, device) && matchesWorkspace(target, workspace));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw Object.assign(new Error(
      `${workspace ? `Workspace \"${workspace}\"` : `Device \"${device}\"`} matches multiple local instances. Use targetId from list_workspaces.`
    ), { code: 'WORKSPACE_SELECTION_REQUIRED' });
  }
  const requested = [device, workspace].filter(Boolean).join('/');
  throw Object.assign(new Error(`Workspace target \"${requested}\" is not online.`), { code: 'WORKSPACE_NOT_FOUND' });
}

export function workspaceSummary(target, selected = null) {
  return {
    id: target.targetId,
    targetId: target.targetId,
    name: target.name,
    mode: target.mode,
    status: 'online',
    selected: selected?.targetId === target.targetId
  };
}
