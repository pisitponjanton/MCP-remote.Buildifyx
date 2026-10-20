// Release checks and host execution use the same shell-free Windows npm resolver.
export { npmInvocation as releaseNpmInvocation } from '../src/utils/npm-invocation.js';
