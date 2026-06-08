import express, { type Express } from 'express';

import { type ReviewSession } from './review-session.js';

export interface ReviewRoutesOptions {
  keepAlive?: boolean;
}

export type ReviewSessionProvider = () => ReviewSession;

export function mountReviewRoutes(
  app: Express,
  prefix: string,
  sessionProvider: ReviewSessionProvider,
  options: ReviewRoutesOptions = {},
): void {
  const router = express.Router();
  const getSession = sessionProvider;

  router.get('/api/diff', async (req, res) => {
    const diff = await getSession().getDiff(req.query as Record<string, unknown>);
    res.json(diff);
  });

  router.get(/^\/api\/generated-status\/(.*)$/, async (req, res) => {
    try {
      const result = await getSession().getGeneratedStatus(req.params[0], req.query.ref);
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

  router.get('/api/revisions', async (_req, res) => {
    try {
      const result = await getSession().getRevisionOptions();
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

  router.get(/^\/api\/line-count\/(.*)$/, async (req, res) => {
    try {
      const result = await getSession().getLineCount(
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

  router.get(/^\/api\/blob\/(.*)$/, async (req, res) => {
    try {
      const result = await getSession().getBlob(req.params[0], req.query.ref);
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

  router.post('/api/comments', (req, res) => {
    try {
      const result = getSession().postComments(req.query as Record<string, unknown>, req.body);
      res.json(result);
    } catch (error) {
      console.error('Error parsing comments:', error);
      res.status(400).json({ error: 'Invalid comment data' });
    }
  });

  router.post('/api/comment-imports', (req, res) => {
    try {
      const result = getSession().postCommentImports(
        req.query as Record<string, unknown>,
        req.body,
      );
      res.json(result);
    } catch (error) {
      console.error('Error parsing comment imports:', error);
      res.status(400).json({ error: 'Invalid comment import data' });
    }
  });

  router.get('/api/comments-json', (req, res) => {
    res.json(getSession().getCommentsJson(req.query as Record<string, unknown>));
  });

  router.get('/api/comments-output', (req, res) => {
    res.type('text/plain');
    res.send(getSession().getCommentsOutput(req.query as Record<string, unknown>));
  });

  router.post('/api/open-in-editor', async (req, res) => {
    const result = await getSession().openInEditor(req.body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(result.value);
  });

  router.get('/api/watch', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    getSession().addWatchClient(res);

    req.on('close', () => {
      getSession().removeWatchClient(res);
    });
  });

  router.get('/api/heartbeat', (_req, res) => {
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
          await getSession().stopFileWatcher();
          getSession().outputFinalComments();
          process.exit(0);
        }, 100);
      }
    });
  });

  app.use(prefix, router);
}
