import { type AddressInfo } from 'net';

import express from 'express';
import { fetch } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { mountReviewRoutes } from './review-routes.js';
import { type ReviewSession } from './review-session.js';

describe('mountReviewRoutes', () => {
  it('mounts review API routes at the provided prefix using the session provider', async () => {
    const app = express();
    const session = {
      getDiff: vi.fn().mockResolvedValue({
        targetCommit: 'abc123',
        baseCommit: 'def456',
        files: [],
        stats: { additions: 0, deletions: 0 },
        isEmpty: true,
        ignoreWhitespace: true,
        openInEditorAvailable: true,
        repositoryId: 'repo-1',
      }),
    } as unknown as ReviewSession;

    mountReviewRoutes(app, '/reviews/default', () => session);

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(
        `http://localhost:${port}/reviews/default/api/diff?ignoreWhitespace=true`,
      );
      const body = (await response.json()) as { repositoryId: string };

      expect(response.ok).toBe(true);
      expect(body.repositoryId).toBe('repo-1');
      expect(session.getDiff).toHaveBeenCalledWith(
        expect.objectContaining({ ignoreWhitespace: 'true' }),
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
