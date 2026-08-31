import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { getCommandToolDefinitions } from './commands.js';
import { getFileToolDefinitions } from './files.js';
import { getSystemToolDefinitions } from './system.js';
import { errorResult, successResult } from '../response.js';

const MANIFEST_VERSION = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function jsonSchema(inputSchema) {
  return inputSchema ? z.toJSONSchema(inputSchema) : { type: 'object', properties: {}, additionalProperties: false };
}

export function getMcpToolDefinitions(options = {}) {
  return [
    ...getSystemToolDefinitions(options),
    ...getFileToolDefinitions(options),
    ...getCommandToolDefinitions(options)
  ];
}

export function createToolManifest(options = {}) {
  const tools = getMcpToolDefinitions(options)
    .map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      permission: definition.permission,
      annotations: stableValue(definition.annotations ?? {}),
      inputSchema: stableValue(jsonSchema(definition.inputSchema))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const fingerprintSource = stableValue({ manifestVersion: MANIFEST_VERSION, tools });
  const hash = createHash('sha256').update(JSON.stringify(fingerprintSource)).digest('hex');

  return {
    manifestVersion: MANIFEST_VERSION,
    count: tools.length,
    hash,
    shortHash: hash.slice(0, 8),
    tools
  };
}

export function registerMcpToolRegistry(server, dispatch, options = {}) {
  const definitions = getMcpToolDefinitions(options);

  for (const definition of definitions) {
    const config = {
      title: definition.title,
      description: definition.description,
      annotations: definition.annotations
    };
    if (definition.inputSchema) config.inputSchema = definition.inputSchema;

    server.registerTool(definition.name, config, async (input = {}) => {
      try {
        const result = await dispatch(definition.name, input ?? {});
        return definition.toMcpResult
          ? definition.toMcpResult(result)
          : successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  return definitions;
}

export function notifyToolListChanged(server) {
  if (!server || typeof server.sendToolListChanged !== 'function') return false;
  try {
    server.sendToolListChanged();
    return true;
  } catch {
    return false;
  }
}
