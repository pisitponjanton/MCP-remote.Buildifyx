import os from 'node:os';
import process from 'node:process';

export function createSystemServices({ root }) {
  return {
    async get_system_info() {
      return {
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        osRelease: os.release(),
        nodeVersion: process.version,
        allowedRoot: root
      };
    }
  };
}
