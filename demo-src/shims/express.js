// Tiny Express-compatible router so the real route modules run unchanged in the browser.
function compile(path) {
  const keys = [];
  const re = new RegExp(`^${path.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}$`);
  return { re, keys };
}
export function Router() {
  const stack = [];
  const add = (method) => (path, ...handlers) => { stack.push({ method, ...compile(path), handlers }); return router; };
  const router = {
    stack,
    get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE'),
    use(fn) { stack.push({ method: null, handlers: [fn] }); return router; },
    async handle(req, res, done) {
      let i = 0;
      const next = async (err) => {
        if (res.finished) return;
        const layer = stack[i++];
        if (!layer) return done(err);
        if (layer.method === null) {
          const fn = layer.handlers[0];
          if (fn.handle) return err ? next(err) : fn.handle(req, res, next);
          if (err && fn.length === 4) return run(() => fn(err, req, res, next));
          if (err || fn.length === 4) return next(err);
          return run(() => fn(req, res, next));
        }
        if (err || layer.method !== req.method) return next(err);
        const m = layer.re.exec(req.path);
        if (!m) return next();
        req.params = Object.fromEntries(layer.keys.map((k, j) => [k, decodeURIComponent(m[j + 1])]));
        let h = 0;
        const step = async (e) => {
          if (e) return next(e);
          const fn = layer.handlers[h++];
          if (!fn) return next();
          return run(() => fn(req, res, step));
        };
        return step();
      };
      const run = async (fn) => { try { await fn(); } catch (e) { await next(e); } };
      await next();
    },
  };
  return router;
}
function express() { throw new Error('Use Router() in the demo.'); }
express.Router = Router;
express.json = () => (req, res, next) => next();
express.static = () => (req, res, next) => next();
export default express;
