import { createApp, startServer } from './app.ts';
import { loadConfig } from './config.ts';
import { log, setLogLevel } from './log.ts';

const cfg = loadConfig();
setLogLevel(cfg.logLevel);

const app = createApp(cfg);
await app.addons.ensureDefaults();
const server = startServer(app);
app.sync.start();

// Refresh addon manifests daily so new catalogs appear.
setInterval(() => app.addons.refreshManifests().catch((e) => log.warn('manifest refresh failed', e)), 24 * 3600_000).unref();

const shutdown = (sig: string) => {
  log.info(`${sig} received, shutting down`);
  app.sync.stop();
  server.close(() => {
    app.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
