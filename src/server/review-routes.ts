import express, { type Express, type Request, type Response } from 'express';

import { type ReviewSession } from './review-session.js';

export interface ReviewRoutesOptions {
  keepAlive?: boolean;
  apiBasePath?: string;
}

export class ReviewRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ReviewSessionProvider = (req: Request) => Promise<ReviewSession> | ReviewSession;

function normalizeApiBasePath(apiBasePath: string | undefined): string {
  if (apiBasePath === undefined) {
    return '/api';
  }

  if (apiBasePath === '' || apiBasePath === '/') {
    return '';
  }

  return apiBasePath.endsWith('/') ? apiBasePath.slice(0, -1) : apiBasePath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRoutePath(apiBasePath: string, path: string): string {
  return `${apiBasePath}${path}`;
}

function createSplatRoute(apiBasePath: string, path: string): RegExp {
  return new RegExp(`^${escapeRegExp(`${apiBasePath}${path}/`)}(.*)$`);
}

function sendSessionProviderError(res: Response, error: unknown): void {
  if (error instanceof ReviewRouteError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  console.error('Error resolving review session:', error);
  res.status(500).json({ error: 'Failed to resolve review session' });
}

export function mountReviewRoutes(
  app: Express,
  prefix: string,
  sessionProvider: ReviewSessionProvider,
  options: ReviewRoutesOptions = {},
): void {
  const router = express.Router({ mergeParams: true });
  const apiBasePath = normalizeApiBasePath(options.apiBasePath);
  const getSession = async (req: Request, res: Response): Promise<ReviewSession | undefined> => {
    try {
      return await sessionProvider(req);
    } catch (error) {
      sendSessionProviderError(res, error);
      return undefined;
    }
  };

  router.get(createRoutePath(apiBasePath, '/diff'), async (req, res) => {
    const session = await getSession(req, res);
    if (!session) {
      return;
    }

    const diff = await session.getDiff(req.query as Record<string, unknown>);
    res.json(diff);
  });

  router.get(createSplatRoute(apiBasePath, '/generated-status'), async (req, res) => {
    try {
      const session = await getSession(req, res);
      if (!session) {
        return;
      }

      const result = await session.getGeneratedStatus(req.params[0], req.query.ref);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      res.json(result.value);
    } catch (error) {
      console.error('Error fetching generated status:', error);
      res.status(500).json({ error: 'Failed to get generated status' });
    }
  });

  router.get(createRoutePath(apiBasePath, '/revisions'), async (req, res) => {
    try {
      const session = await getSession(req, res);
      if (!session) {
        return;
      }

      const result = await session.getRevisionOptions();
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      res.json(result.value);
    } catch (error) {
      console.error('Error fetching revisions:', error);
      res.status(500).json({ error: 'Failed to fetch revisions' });
    }
  });

  router.get(createSplatRoute(apiBasePath, '/line-count'), async (req, res) => {
    try {
      const session = await getSession(req, res);
      if (!session) {
        return;
      }

      const result = await session.getLineCount(
        req.params[0],
        req.query.oldRef as string | undefined,
        req.query.oldPath,
        req.query.newRef as string | undefined,
      );
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      res.json(result.value);
    } catch (error) {
      console.error('Error fetching line count:', error);
      res.status(500).json({ error: 'Failed to get line count' });
    }
  });

  router.get(createSplatRoute(apiBasePath, '/blob'), async (req, res) => {
    try {
      const session = await getSession(req, res);
      if (!session) {
        return;
      }

      const result = await session.getBlob(req.params[0], req.query.ref);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      res.setHeader('Content-Type', result.value.contentType);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(result.value.blob);
    } catch (error) {
      console.error('Error fetching blob:', error);
      res.status(404).json({ error: 'File not found' });
    }
  });

  router.post(createRoutePath(apiBasePath, '/comments'), async (req, res) => {
    try {
      const session = await getSession(req, res);
      if (!session) {
        return;
      }

      const result = session.postComments(req.query as Record<string, unknown>, req.body);
      res.json(result);
    } catch (error) {
      console.error('Error parsing comments:', error);
      res.status(400).json({ error: 'Invalid comment data' });
    }
  });

  router.post(createRoutePath(apiBasePath, '/comment-imports'), async (req, res) => {
    try {
      const session = await getSession(req, res);
      if (!session) {
        return;
      }

      const result = session.postCommentImports(req.query as Record<string, unknown>, req.body);
      res.json(result);
    } catch (error) {
      console.error('Error parsing comment imports:', error);
      res.status(400).json({ error: 'Invalid comment import data' });
    }
  });

  router.get(createRoutePath(apiBasePath, '/comments-json'), async (req, res) => {
    const session = await getSession(req, res);
    if (!session) {
      return;
    }

    res.json(session.getCommentsJson(req.query as Record<string, unknown>));
  });

  router.get(createRoutePath(apiBasePath, '/comments-output'), async (req, res) => {
    const session = await getSession(req, res);
    if (!session) {
      return;
    }

    res.type('text/plain');
    res.send(session.getCommentsOutput(req.query as Record<string, unknown>));
  });

  router.post(createRoutePath(apiBasePath, '/open-in-editor'), async (req, res) => {
    const session = await getSession(req, res);
    if (!session) {
      return;
    }

    const result = await session.openInEditor(req.body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(result.value);
  });

  router.get(createRoutePath(apiBasePath, '/watch'), async (req, res) => {
    const session = await getSession(req, res);
    if (!session) {
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    session.addWatchClient(res);

    req.on('close', () => {
      session.removeWatchClient(res);
    });
  });

  router.get(createRoutePath(apiBasePath, '/heartbeat'), async (req, res) => {
    const session = await getSession(req, res);
    if (!session) {
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    res.write('data: connected\n\n');

    const heartbeatInterval = setInterval(() => {
      res.write('data: heartbeat\n\n');
    }, 5000);

    res.req.on('close', () => {
      clearInterval(heartbeatInterval);
      if (options.keepAlive) {
        console.log('Client disconnected, but server is staying alive (--keep-alive)');
        console.log('Press Ctrl+C to stop the server');
      } else {
        setTimeout(async () => {
          console.log('Client disconnected, shutting down server...');
          await session.stopFileWatcher();
          session.outputFinalComments();
          process.exit(0);
        }, 100);
      }
    });
  });

  app.use(prefix, router);
}
