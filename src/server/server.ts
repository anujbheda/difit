import { type Server } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import express, { type Express } from 'express';
import open from 'open';

import { mountReviewRoutes, ReviewRouteError } from './review-routes.js';
import { ReviewSession, type ReviewSessionOptions } from './review-session.js';
import { WorktreeHub } from './worktree-hub.js';
import { WorktreeRegistryError, type WorktreeRegistrationInput } from './worktree-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ServerOptions extends ReviewSessionOptions {
  preferredPort?: number;
  host?: string;
  openBrowser?: boolean;
  keepAlive?: boolean;
  hubMode?: boolean;
  worktreeRegistryPath?: string;
  trustedWorktreeRoots?: string[];
}

export async function startServer(
  options: ServerOptions,
): Promise<{ port: number; url: string; isEmpty?: boolean; server?: Server }> {
  const app = express();
  const hub = options.hubMode ? await WorktreeHub.create(options) : undefined;
  const session = hub ? undefined : await ReviewSession.create(options);
  let serverUrl = '';

  app.use(express.json());
  app.use(express.text());

  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  if (hub) {
    mountWorktreeRegistryRoutes(app, hub, () => serverUrl);
    mountReviewRoutes(app, '/api/worktrees/:worktreeId', (req) => hub.getSessionFromRequest(req), {
      apiBasePath: '',
      keepAlive: options.keepAlive,
    });
    mountReviewRoutes(
      app,
      '',
      () => {
        throw new ReviewRouteError(
          400,
          'Hub mode requires scoped review APIs. Use /api/worktrees/:id/diff.',
        );
      },
      { keepAlive: options.keepAlive },
    );
  } else {
    mountReviewRoutes(
      app,
      '',
      () => {
        if (!session) {
          throw new ReviewRouteError(500, 'Review session is not available');
        }

        return session;
      },
      { keepAlive: options.keepAlive },
    );
  }

  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV !== 'development';

  if (isProduction) {
    const distPath = join(__dirname, '..', 'client');
    app.use(express.static(distPath));
  } else {
    app.get('/', (_req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>difit - Dev Mode</title>
          </head>
          <body>
            <div id="root"></div>
            <script>
              console.log('difit development mode');
              console.log('Diff data available at /api/diff');
            </script>
          </body>
        </html>
      `);
    });
  }

  const { port, url, server } = await startServerWithFallback(
    app,
    options.preferredPort || 4966,
    options.host || 'localhost',
  );
  serverUrl = url;

  if (options.host && options.host !== '127.0.0.1' && options.host !== 'localhost') {
    console.warn('\n⚠️  WARNING: Server is accessible from external network!');
    console.warn(`   Binding to: ${options.host}:${port}`);
    console.warn('   Make sure this is intended and your network is secure.\n');
  }

  if (session) {
    try {
      await session.startFileWatcher();
    } catch (error) {
      console.warn('⚠️  File watcher failed to start:', error);
      console.warn('   Continuing without file watching...');
    }
  }

  if (session && !session.isEmpty && options.openBrowser) {
    try {
      await open(url);
    } catch {
      console.warn('Failed to open browser automatically');
    }
  }

  return { port, url, isEmpty: session?.isEmpty, server };
}

function sendWorktreeError(res: express.Response, error: unknown): void {
  if (error instanceof WorktreeRegistryError || error instanceof ReviewRouteError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  console.error('Error handling worktree request:', error);
  res.status(500).json({ error: 'Failed to handle worktree request' });
}

function mountWorktreeRegistryRoutes(
  app: Express,
  hub: WorktreeHub,
  getServerUrl: () => string,
): void {
  app.get('/api/worktrees', async (_req, res) => {
    try {
      res.json({ worktrees: await hub.listWorktrees() });
    } catch (error) {
      sendWorktreeError(res, error);
    }
  });

  app.post('/api/worktrees', async (req, res) => {
    try {
      const worktree = await hub.registerWorktree(req.body as WorktreeRegistrationInput);
      res.status(201).json(worktree);
    } catch (error) {
      sendWorktreeError(res, error);
    }
  });

  app.get('/api/worktrees/:id', async (req, res) => {
    try {
      res.json(await hub.getWorktree(req.params.id));
    } catch (error) {
      sendWorktreeError(res, error);
    }
  });

  app.patch('/api/worktrees/:id', async (req, res) => {
    try {
      res.json(await hub.patchWorktree(req.params.id, req.body as WorktreeRegistrationInput));
    } catch (error) {
      sendWorktreeError(res, error);
    }
  });

  app.delete('/api/worktrees/:id', async (req, res) => {
    try {
      await hub.deleteWorktree(req.params.id);
      res.status(204).send();
    } catch (error) {
      sendWorktreeError(res, error);
    }
  });

  app.post('/api/worktrees/:id/publish', async (req, res) => {
    try {
      res.json(await hub.publishWorktree(req.params.id, getServerUrl()));
    } catch (error) {
      sendWorktreeError(res, error);
    }
  });
}

async function startServerWithFallback(
  app: Express,
  preferredPort: number,
  host: string,
): Promise<{ port: number; url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(preferredPort, host, (err: NodeJS.ErrnoException | undefined) => {
      const displayHost = host === '0.0.0.0' ? 'localhost' : host;
      const url = `http://${displayHost}:${preferredPort}`;
      if (!err) {
        resolve({ port: preferredPort, url, server });
        return;
      }

      switch (err.code) {
        case 'EADDRINUSE': {
          console.log(`Port ${preferredPort} is busy, trying ${preferredPort + 1}...`);
          return startServerWithFallback(app, preferredPort + 1, host)
            .then(({ port, url, server }) => {
              resolve({ port, url, server });
            })
            .catch(reject);
        }
        default: {
          reject(new Error(`Failed to launch a server: ${err.message}`));
        }
      }
    });
  });
}
