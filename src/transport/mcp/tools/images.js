import * as z from 'zod/v4';

const imagePath = z.string().min(1).max(4096);
const artifactId = z.string().regex(/^art_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const selector = z.union([
  z.object({ path: imagePath, artifactId: z.never().optional() }),
  z.object({ artifactId, path: z.never().optional() })
]);
const dimensions = {
  width: z.number().int().min(1).max(4096).optional(),
  height: z.number().int().min(1).max(4096).optional(),
  format: z.enum(['png', 'jpeg', 'webp']).optional()
};
const definitions = [
  ['read_image', 'Read image into temporary cache', 'imageRead', z.object({ path: imagePath }), true, false],
  ['get_image_info', 'Inspect image metadata', 'imageRead', selector, true, false],
  ['resize_image', 'Resize image into temporary cache', 'imageRead', z.intersection(selector, z.object(dimensions)), false, false],
  ['save_image', 'Explicitly save workspace image copy', 'imageSave',
    z.object({ path: imagePath, destinationPath: imagePath }), false, true],
  ['list_cached_assets', 'List workspace cached images', 'cacheManage', z.object({}), true, false],
  ['get_cached_image', 'Inspect cached image', 'imageRead', z.object({ artifactId }), true, false],
  ['save_cached_image', 'Explicitly save cached image permanently', 'imageSave',
    z.object({ artifactId, destinationPath: imagePath }), false, true],
  ['delete_cached_asset', 'Delete a temporary artifact', 'cacheManage', z.object({ artifactId }), false, true],
  ['clear_cache', 'Clear temporary workspace cache', 'cacheManage', z.object({}), false, true]
];

export function getImageToolDefinitions() {
  return definitions.map(([name, title, permission, inputSchema, readOnlyHint, destructiveHint]) => ({
    name, title, permission, inputSchema,
    description: name === 'get_cached_image' || name === 'read_image' || name === 'resize_image'
      ? 'Work with an authorized PNG/JPEG/WebP image. In Local MCP this can return ImageContent via bounded IPC chunks; Cloud returns metadata unless a compatible relay explicitly negotiates media transfer.'
      : name.startsWith('save_')
        ? (name === 'save_image'
          ? 'Copy a source image to a new explicitly authorized destination. Requires both imageRead for source and imageSave for destination, with independent Ask approval. Never overwrites.'
          : 'Save an image to an explicitly authorized path as a new file only. Never overwrites existing files. No automatic permanent save.')
        : 'Manage only this workspace’s temporary image artifacts. Requires permission; no permanent workspace files are deleted.',
    annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: false }
  }));
}
