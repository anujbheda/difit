import { type Request } from 'express';

import { DiffMode } from '../types/watch.js';
import { createDiffSelection } from '../utils/diffSelection.js';

import { ReviewRouteError } from './review-routes.js';
import { ReviewSession, type ReviewSessionOptions } from './review-session.js';
import {
  WorktreeRegistry,
  WorktreeRegistryError,
  type WorktreeRegistration,
  type WorktreeRegistrationInput,
  type WorktreeRegistrationView,
  type WorktreeRegistryOptions,
} from './worktree-registry.js';

export interface WorktreeHubOptions extends ReviewSessionOptions {
  worktreeRegistryPath?: string;
  trustedWorktreeRoots?: string[];
}

export interface WorktreeSession {
  registration: WorktreeRegistration;
  session: ReviewSession;
}

export interface WorktreePublishResponse {
  id: string;
  url: string;
  localUrl: string;
  isEmpty: boolean;
  filesChanged: number;
  base: string;
  target: string;
}

function determineWorktreeDiffMode(registration: WorktreeRegistration): DiffMode {
  switch (registration.target) {
    case 'working':
      return DiffMode.WORKING;
    case 'staged':
      return DiffMode.STAGED;
    case '.':
      return DiffMode.DOT;
    case 'HEAD':
      return registration.base === 'HEAD^' ? DiffMode.DEFAULT : DiffMode.SPECIFIC;
    default:
      return DiffMode.SPECIFIC;
  }
}

function toRouteError(error: unknown): ReviewRouteError {
  if (error instanceof ReviewRouteError) {
    return error;
  }
  if (error instanceof WorktreeRegistryError) {
    return new ReviewRouteError(error.status, error.message);
  }

  return new ReviewRouteError(
    500,
    error instanceof Error ? error.message : 'Failed to resolve worktree session',
  );
}

function getWorktreeIdFromRequest(req: Request): string {
  const value = req.params.worktreeId ?? req.params.id;
  if (typeof value !== 'string') {
    throw new ReviewRouteError(400, 'Worktree id is required');
  }

  return value;
}

export class WorktreeHub {
  private readonly sessions = new Map<string, WorktreeSession>();

  private constructor(
    private readonly registry: WorktreeRegistry,
    private readonly options: WorktreeHubOptions,
  ) {}

  static async create(options: WorktreeHubOptions): Promise<WorktreeHub> {
    const registryOptions: WorktreeRegistryOptions = {
      storagePath: options.worktreeRegistryPath,
      trustedRoots: options.trustedWorktreeRoots,
    };
    const registry = await WorktreeRegistry.create(registryOptions);
    return new WorktreeHub(registry, options);
  }

  async listWorktrees(): Promise<WorktreeRegistrationView[]> {
    return await this.registry.list();
  }

  async registerWorktree(input: WorktreeRegistrationInput): Promise<WorktreeRegistrationView> {
    return await this.registry.register(input);
  }

  async getWorktree(id: unknown): Promise<WorktreeRegistrationView> {
    return await this.registry.get(id);
  }

  async patchWorktree(
    id: unknown,
    input: WorktreeRegistrationInput,
  ): Promise<WorktreeRegistrationView> {
    const result = await this.registry.patch(id, input);
    await this.dropSession(result.id);
    return result;
  }

  async deleteWorktree(id: unknown): Promise<void> {
    const registration = this.registry.getStored(id);
    await this.registry.delete(registration.id);
    await this.dropSession(registration.id);
  }

  async publishWorktree(id: unknown, serverUrl: string): Promise<WorktreePublishResponse> {
    const registration = this.registry.getStored(id);
    const session = await this.getSessionForRegistration(registration);
    const diff = await session.getDiff({});
    const encodedId = encodeURIComponent(registration.id);
    const url = `${serverUrl}/worktrees/${encodedId}`;

    return {
      id: registration.id,
      url,
      localUrl: url,
      isEmpty: Boolean(diff.isEmpty),
      filesChanged: diff.files.length,
      base: registration.base,
      target: registration.target,
    };
  }

  async getSessionFromRequest(req: Request): Promise<ReviewSession> {
    try {
      const registration = this.registry.getStored(getWorktreeIdFromRequest(req));
      return await this.getSessionForRegistration(registration);
    } catch (error) {
      throw toRouteError(error);
    }
  }

  private async getSessionForRegistration(
    registration: WorktreeRegistration,
  ): Promise<ReviewSession> {
    if (await this.registry.isMissing(registration)) {
      throw new ReviewRouteError(404, 'Registered worktree path is missing');
    }

    const existing = this.sessions.get(registration.id);
    if (existing && existing.registration.updatedAt === registration.updatedAt) {
      return existing.session;
    }

    if (existing) {
      await existing.session.stopFileWatcher();
    }

    const session = await ReviewSession.create({
      selection: createDiffSelection(registration.base, registration.target, registration.baseMode),
      repoPath: registration.path,
      clearComments: this.options.clearComments,
      contextLines: this.options.contextLines,
      diffMode: determineWorktreeDiffMode(registration),
    });

    try {
      await session.startFileWatcher();
    } catch (error) {
      console.warn('⚠️  Worktree file watcher failed to start:', error);
      console.warn('   Continuing without file watching...');
    }

    this.sessions.set(registration.id, { registration, session });
    return session;
  }

  private async dropSession(id: string): Promise<void> {
    const existing = this.sessions.get(id);
    if (existing) {
      await existing.session.stopFileWatcher();
      this.sessions.delete(id);
    }
  }
}
