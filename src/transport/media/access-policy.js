import { MEDIA_TOOLS } from './protocol.js';

// Tool approval (including one-time Ask) grants access to the tool response,
// NOT a perpetual capability to stream cached bytes afterward. Binary media
// is available only while every applicable policy category remains Allow.
// Re-read the policy after the asynchronous provenance lookup so downgrades
// during that lookup cannot resurrect an old transfer.
export function createMediaTransferPermission({ getCategories, isCaptureArtifact }) {
  if (typeof getCategories !== 'function' || typeof isCaptureArtifact !== 'function') {
    throw new TypeError('Media transfer requires current policy and artifact provenance.');
  }
  return async function canTransfer({ tool, artifactId }) {
    if (!MEDIA_TOOLS.has(tool) || typeof artifactId !== 'string' || !artifactId) return false;
    const needsCapture = tool === 'browser_screenshot' || await isCaptureArtifact(artifactId);
    const categories = getCategories();
    if (categories?.[tool === 'browser_screenshot' ? 'browserCapture' : 'imageRead'] !== 'allow') return false;
    if (needsCapture && categories?.browserCapture !== 'allow') return false;
    return true;
  };
}
