import type { App } from '../app.ts';

export function registerAdminRoutes(app: App): void {
  app.router.get('/admin', (c) => {
    c.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    c.res.end('<h1>Bridgefin</h1>');
  }, { public: true });
}
