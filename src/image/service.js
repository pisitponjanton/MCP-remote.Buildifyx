import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AgentError, ErrorCode, asFileError } from '../core/errors.js';
import { createArtifactCache } from '../cache/store.js';
import { classifyPath } from '../security/scope.js';

// Sharp's ESM entry uses JSON import attributes unavailable in Node 20.9.
// Its supported CommonJS entry works on the minimum declared Node runtime.
const require = createRequire(import.meta.url);
let sharpLoader;
async function getSharp() {
  sharpLoader ??= Promise.resolve().then(() => require('sharp')).catch((error) => { sharpLoader = null; throw error; });
  return sharpLoader;
}

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_SIDE = 8192;
export const MAX_RESIZE_SIDE = 4096;

function problem(code, message) { return new AgentError(code, message); }
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const NEW_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const formats = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function imagePathError(error) {
  if (['ENOENT', 'ENOTDIR', ErrorCode.FILE_NOT_FOUND].includes(error?.code)) {
    return problem('IMAGE_NOT_FOUND', 'Image source was not found.');
  }
  return asFileError(error);
}

export function detectImageMime(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) throw problem('IMAGE_INVALID', 'Invalid image content.');
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw problem('IMAGE_FORMAT_UNSUPPORTED', 'Only PNG, JPEG and WebP are supported.');
}

async function inspectImage(data, { decode = true } = {}) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_IMAGE_BYTES) {
    throw problem('IMAGE_TOO_LARGE', 'Image exceeds the 16 MiB limit or is empty.');
  }
  const mimeType = detectImageMime(data);
  try {
    const sharp = await getSharp();
    const processor = sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error', animated: false });
    const meta = await processor.metadata();
    if (formats[meta.format] !== mimeType || !Number.isInteger(meta.width) || !Number.isInteger(meta.height)
      || meta.width <= 0 || meta.height <= 0 || meta.width > MAX_IMAGE_SIDE || meta.height > MAX_IMAGE_SIDE
      || meta.width * meta.height > MAX_IMAGE_PIXELS || (meta.pages && meta.pages !== 1)) {
      throw problem('IMAGE_INVALID', 'Unsupported image dimensions, format or animation.');
    }
    if (decode) await sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error', animated: false }).stats();
    return { mimeType, format: meta.format, width: meta.width, height: meta.height, size: data.length,
      sha256: createHash('sha256').update(data).digest('hex') };
  } catch (error) {
    if (error?.code?.startsWith('IMAGE_')) throw error;
    throw problem('IMAGE_INVALID', 'Image is malformed or exceeds decoder limits.');
  }
}

async function readBoundedFile(filename) {
  const before = await lstat(filename).catch(error => { throw imagePathError(error); });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw problem('IMAGE_INVALID_PATH', 'Image must be a regular file.');
  if (before.size <= 0 || before.size > MAX_IMAGE_BYTES) throw problem('IMAGE_TOO_LARGE', 'Image exceeds allowed size.');
  const fd = await open(filename, READ_FLAGS).catch(error => { throw imagePathError(error); });
  try {
    const actual = await fd.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) {
      throw problem('IMAGE_INVALID_PATH', 'Image file changed during access.');
    }
    const data = await fd.readFile();
    if (data.length !== actual.size) throw problem('IMAGE_INVALID', 'Incomplete image read.');
    return data;
  } finally { await fd.close(); }
}

async function validatedPath(root, userPath, context, key, newFile = false) {
  const approved = context[key];
  const policyRoots = approved?.matchedRoot ? [approved.matchedRoot] : [];
  const classified = await classifyPath({ root, additionalRoots: policyRoots, userPath, newFile }).catch(error => { throw imagePathError(error); });
  if (classified.scope === 'outside' && approved?.scope !== 'outside') {
    throw problem('IMAGE_PATH_DENIED', 'Destination or source is not authorized.');
  }
  if (approved && classified.resolved !== approved.resolved) {
    throw problem('IMAGE_PATH_CHANGED', 'Path changed after authorization.');
  }
  if (!approved && classified.scope !== 'root') throw problem('IMAGE_PATH_DENIED', 'Path is outside the workspace.');
  return classified.resolved;
}

async function writeDurable(root, destinationPath, data, context) {
  const dest = await validatedPath(root, destinationPath, context, 'destinationPathInfo', true);
  const dir = path.dirname(dest);
  const parent = await realpath(dir);
  if (parent !== dir) throw problem('IMAGE_PATH_CHANGED', 'Destination parent changed.');
  // Reject overwrite, symlink and hard-link replacement using exclusive create.
  context.throwIfCancelled?.();
  context.assertStillAllowed?.();
  context.commitSideEffect?.();
  let handle;
  try {
    handle = await open(dest, NEW_FLAGS, 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally { await handle.close(); }
    const finalParent = await realpath(dir);
    if (finalParent !== parent) throw problem('IMAGE_PATH_CHANGED', 'Destination parent was replaced.');
    return { path: dest, saved: true, size: data.length };
  } catch (error) {
    if (handle && error?.code !== 'EEXIST') {
      // Clean only the newly-created file. Never follow links to another destination.
      await unlink(dest).catch(() => undefined);
    }
    if (error?.code === 'EEXIST') throw problem('IMAGE_EXISTS', 'Destination already exists; overwriting is not allowed.');
    throw error;
  }
}

export function createImageServices({ root, namespace = 'cloud', principalId = null, cache = createArtifactCache({ workspaceRoot: root, namespace, principalId }), getPolicy = () => ({ categories: { browserCapture: 'deny' } }) }) {
  if (principalId !== null && principalId !== undefined) cache.bindPrincipal(principalId);
  const imported = new Map();
  const IMPORT_TTL_MS = 5 * 60_000;
  const IMPORT_MAX_ITEMS = 2;
  const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
  let importSweep=null;
  function startImportSweep(){
    if(importSweep)return;
    importSweep=setInterval(()=>pruneImports(),5000);
    importSweep.unref?.();
  }
  function stopImportSweep(){if(importSweep)clearInterval(importSweep);importSweep=null;}
  function pruneImports() {
    for (const [id, item] of imported) if (item.expiresAt <= Date.now()) {
      item.data.fill(0);
      imported.delete(id);
    }
    if(imported.size===0)stopImportSweep();
  }
  function clearImports() { for(const item of imported.values())item.data.fill(0);imported.clear();stopImportSweep(); }
  function requireImportPermission() {
    const categories=getPolicy()?.categories ?? {};
    if(categories.imageRead !== 'allow' || categories.cacheManage !== 'allow') {
      throw problem('MEDIA_IMPORT_PERMISSION_REQUIRED',
        'Local image read and temporary cache management must be explicitly allowed.');
    }
  }
  let initializing;
  async function ready() {
    initializing ??= cache.initialize({ periodic: true }).catch((error) => { initializing = null; throw error; });
    await initializing;
  }
  // Legacy origin=generated did not preserve screenshot lineage. Fail closed for
  // old entries until their TTL expires; new normal resizes use generated-safe.
  const captureProtected = metadata => metadata?.kind === 'screenshot'
    || metadata?.origin === 'capture' || metadata?.origin === 'generated';
  function requireCapture(metadata, context = {}) {
    if (!captureProtected(metadata)) return;
    const state = getPolicy().categories?.browserCapture ?? 'deny';
    if (state === 'deny') throw problem('BROWSER_CAPTURE_DENIED', 'Screenshot access has been revoked.');
    if (state !== 'allow' && context.screenshotApproved !== true)
      throw problem('CONFIRMATION_REQUIRED', 'Screenshot artifact requires browserCapture approval.');
    context.assertStillAllowed?.();
    context.throwIfCancelled?.();
  }
  async function isCaptureArtifact(artifactId) {
    pruneImports();
    if (imported.has(artifactId)) return false;
    await ready();
    const { metadata } = await cache.get(artifactId);
    return captureProtected(metadata);
  }
  async function fromPath(userPath, context) {
    const filename = await validatedPath(root, userPath, context, 'sourcePathInfo');
    context.throwIfCancelled?.();
    const data = await readBoundedFile(filename);
    context.throwIfCancelled?.();
    return { data, info: await inspectImage(data) };
  }
  async function fromCache(artifactId, context) {
    pruneImports();
    const memory=imported.get(artifactId);
    if(memory){
      requireImportPermission();
      context.throwIfCancelled?.();
      const info=await inspectImage(memory.data);
      requireImportPermission();
      return {data:memory.data,info,metadata:{kind:'image',origin:'import',mimeType:info.mimeType}};
    }
    await ready();
    context.throwIfCancelled?.();
    const { data, metadata } = await cache.get(artifactId);
    if (!['image', 'screenshot'].includes(metadata.kind)) throw problem('IMAGE_INVALID', 'Artifact is not an image.');
    requireCapture(metadata, context);
    const info = await inspectImage(data);
    if (metadata.mimeType !== info.mimeType) throw problem('IMAGE_INVALID', 'Cached MIME does not match image bytes.');
    requireCapture(metadata, context);
    context.throwIfCancelled?.();
    return { data, info, metadata };
  }
  async function cacheImage(data, info, context, origin = 'import') {
    await ready();
    context.throwIfCancelled?.();
    context.commitSideEffect?.();
    const asset = await cache.put({ data, mimeType: info.mimeType, kind: 'image', origin });
    return { ...info, artifactId: asset.id, expiresAt: asset.expiresAt, imageBytesDelivered: false,
      message: 'Image cached locally. Local MCP can deliver image bytes; Cloud requires versioned media capability acknowledgement.' };
  }
  return {
    async __importCloudImage(data) {
      requireImportPermission();
      pruneImports();
      if(!Buffer.isBuffer(data) || !data.length || data.length>IMPORT_MAX_BYTES ||
        imported.size>=IMPORT_MAX_ITEMS) {
        throw problem('MEDIA_IMPORT_BUSY','Temporary local import capacity exceeded.');
      }
      const info=await inspectImage(data);
      requireImportPermission();
      const artifactId='art_'+randomUUID();
      imported.set(artifactId,{data:Buffer.from(data),expiresAt:Date.now()+IMPORT_TTL_MS});
      startImportSweep();
      return {artifactId,mimeType:info.mimeType,size:info.size,sha256:info.sha256,expiresInSeconds:300};
    },
    __clearCloudImports:clearImports,
    __artifactRequiresCapture: isCaptureArtifact,
    async __readImageBytes(artifactId, context = {}) {
      const { data, info } = await fromCache(artifactId, context);
      return { data, metadata: info };
    },
    async __storeScreenshot(data, context = {}) {
      await ready();
      context.throwIfCancelled?.();
      const info = await inspectImage(data);
      if (!['image/png', 'image/jpeg'].includes(info.mimeType)) {
        throw problem('IMAGE_FORMAT_UNSUPPORTED', 'Screenshot must be PNG or JPEG.');
      }
      context.throwIfCancelled?.();
      context.commitSideEffect?.();
      const asset = await cache.put({ data, mimeType: info.mimeType, kind: 'screenshot', origin: 'capture' });
      return { ...info, artifactId: asset.id, expiresAt: asset.expiresAt, imageBytesDelivered: false };
    },
    async __compareScreenshots(beforeArtifactId, afterArtifactId, context = {}) {
      await ready();
      context.throwIfCancelled?.();
      const first = await cache.get(beforeArtifactId);
      const second = await cache.get(afterArtifactId);
      requireCapture(first.metadata, context);
      requireCapture(second.metadata, context);
      if (first.metadata.kind !== 'screenshot' || second.metadata.kind !== 'screenshot') {
        throw problem('IMAGE_INVALID', 'Only screenshot artifacts can be compared.');
      }
      const left = await inspectImage(first.data);
      const right = await inspectImage(second.data);
      const dimensionsMatch = left.width === right.width && left.height === right.height;
      if (!dimensionsMatch) return { dimensionsMatch: false, before: { width: left.width, height: left.height },
        after: { width: right.width, height: right.height }, changedPercent: null, sampledPixels: 0 };
      const sharp = await getSharp();
      const width = Math.min(left.width, 512);
      const height = Math.min(left.height, 512);
      const sample = async bytes => sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' })
        .resize(width, height, { fit: 'fill', kernel: 'nearest' }).removeAlpha().raw().toBuffer();
      const [a,b] = await Promise.all([sample(first.data),sample(second.data)]);
      let changed = 0;
      for (let i = 0; i < a.length; i += 3) {
        if (Math.abs(a[i] - b[i]) > 12 || Math.abs(a[i + 1] - b[i + 1]) > 12 || Math.abs(a[i + 2] - b[i + 2]) > 12) changed++;
      }
      context.throwIfCancelled?.();
      return { dimensionsMatch: true, before: { width: left.width, height: left.height },
        after: { width: right.width, height: right.height },
        changedPercent: Math.round((changed / (width * height)) * 10000) / 100,
        sampledPixels: width * height };
    },
    closeImageCache() { clearImports(); cache.close(); },
    async read_image({ path }, context = {}) {
      const { data, info } = await fromPath(path, context);
      return cacheImage(data, info, context);
    },
    async get_image_info({ path, artifactId }, context = {}) {
      const result = artifactId ? await fromCache(artifactId, context) : await fromPath(path, context);
      return { ...result.info, ...(artifactId ? { artifactId } : {}) };
    },
    async resize_image({ path, artifactId, width, height, format }, context = {}) {
      if (!width && !height) throw problem('IMAGE_INVALID', 'Specify width or height.');
      if ([width, height].some((dimension) => dimension !== undefined && (!Number.isInteger(dimension) || dimension <= 0 || dimension > MAX_RESIZE_SIDE))) {
        throw problem('IMAGE_INVALID', 'Resize dimensions must be integers between 1 and 4096.');
      }
      const { data, info, metadata } = artifactId ? await fromCache(artifactId, context) : await fromPath(path, context);
      context.throwIfCancelled?.();
      const type = format ?? info.format;
      if (!Object.hasOwn(formats, type)) throw problem('IMAGE_FORMAT_UNSUPPORTED', 'Unsupported output format.');
      let output;
      try {
        const sharp = await getSharp();
        output = await sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' })
          .rotate().resize({ width, height, fit: 'inside', withoutEnlargement: true })
          .toFormat(type, { quality: 85 }).toBuffer();
      } catch { throw problem('IMAGE_INVALID', 'Failed to resize image.'); }
      const result = await inspectImage(output);
      return cacheImage(output, result, context, captureProtected(metadata) ? 'capture' : 'generated-safe');
    },
    async save_image({ path, destinationPath }, context = {}) {
      // Both source imageRead and destination imageSave must remain authorized
      // before source access and after asynchronous decode/path validation.
      context.assertStillAllowed?.();
      const { data, info } = await fromPath(path, context);
      context.assertStillAllowed?.();
      const saved = await writeDurable(root, destinationPath, data, context);
      return { ...saved, mimeType: info.mimeType, sha256: info.sha256 };
    },
    async list_cached_assets(_input = {}, context = {}) {
      await ready();
      context.throwIfCancelled?.();
      pruneImports();
      return { assets: [...(await cache.list()).filter(entry => ['image', 'screenshot'].includes(entry.kind)
        && (!captureProtected(entry) || getPolicy().categories?.browserCapture === 'allow')),
        ...[...imported.entries()].map(([id,value])=>({id,kind:'image',origin:'import',expiresAt:value.expiresAt}))] };
    },
    async get_cached_image({ artifactId }, context = {}) {
      const { info } = await fromCache(artifactId, context);
      return { artifactId, ...info, imageBytesDelivered: false, message: 'Local MCP delivers image bytes using bounded chunks; Cloud requires a negotiated media feature.' };
    },
    async save_cached_image({ artifactId, destinationPath }, context = {}) {
      pruneImports();
      const temporary=imported.get(artifactId);
      if (temporary) {
        requireImportPermission();
        context.throwIfCancelled?.();
        // Use a private copy: disconnect/revoke/clear_cache zeroes the RAM
        // artifact, but must never turn an already committed save into zeros.
        const data = Buffer.from(temporary.data);
        try {
          const info = await inspectImage(data);
          const ensureCurrentImport = () => {
            pruneImports();
            requireImportPermission();
            if (imported.get(artifactId) !== temporary) {
              throw problem('MEDIA_IMPORT_PERMISSION_REQUIRED', 'Temporary image is no longer authorized.');
            }
          };
          ensureCurrentImport();
          // Recheck the import source after the potentially asynchronous
          // destination-path classification and after imageSave checks.
          const saveContext = { ...context, assertStillAllowed() {
            context.assertStillAllowed?.();
            ensureCurrentImport();
          } };
          const saved = await writeDurable(root, destinationPath, data, saveContext);
          return { ...saved, mimeType: info.mimeType, sha256: info.sha256 };
        } finally {
          data.fill(0);
        }
      }
      await ready();
      // Keep the transfer lease until the permanent save completes.
      return cache.withLease(artifactId, async ({ read, metadata }) => {
        if (!['image', 'screenshot'].includes(metadata.kind)) throw problem('IMAGE_INVALID', 'Artifact is not an image.');
        requireCapture(metadata, context);
        const data = await read();
        const info = await inspectImage(data);
        if (info.mimeType !== metadata.mimeType) throw problem('IMAGE_INVALID', 'Cached MIME does not match image bytes.');
        requireCapture(metadata, context);
        return { ...(await writeDurable(root, destinationPath, data, context)), mimeType: info.mimeType, sha256: info.sha256 };
      });
    },
    async delete_cached_asset({ artifactId }, context = {}) {
      await ready();
      context.throwIfCancelled?.();
      context.commitSideEffect?.();
      const memory=imported.get(artifactId);
      if(memory){memory.data.fill(0);imported.delete(artifactId);return {deleted:true};}
      return { deleted: await cache.remove(artifactId) };
    },
    async clear_cache(_input = {}, context = {}) {
      await ready();
      context.throwIfCancelled?.();
      context.commitSideEffect?.();
      const count=imported.size;
      clearImports();
      const { removed } = await cache.clear();
      return { removed:removed+count };
    }
  };
}
