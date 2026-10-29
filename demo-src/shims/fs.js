// Virtual file system: only the SQL migrations are needed in the browser.
import m1 from '../../server/migrations/001_init.sql';
import m2 from '../../server/migrations/002_reference_data.sql';
const files = { '001_init.sql': m1, '002_reference_data.sql': m2 };
export const readdirSync = () => Object.keys(files);
export const readFileSync = (p) => files[p.split('/').pop()];
export const mkdirSync = () => {};
export const mkdtempSync = () => { throw new Error('Not available in the demo.'); };
export const writeFileSync = () => { throw new Error('Not available in the demo.'); };
export const rm = () => {};
export default { readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rm };
