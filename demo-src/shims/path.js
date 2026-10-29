export const join = (...p) => p.filter(Boolean).join('/').replace(/\/+/g, '/');
export const dirname = (p) => p.split('/').slice(0, -1).join('/') || '.';
export const basename = (p) => p.split('/').pop();
export default { join, dirname, basename };
