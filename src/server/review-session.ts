import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { isAbsolute, resolve, sep } from 'path';

import { type Response } from 'express';

import { type DiffMode } from '../types/watch.js';
import { formatCommentsOutput } from '../utils/commentFormatting.js';
import {
  mergeCommentImports,
  mergeCommentThreads,
  normalizeCommentImports,
  serializeCommentImports,
} from '../utils/commentImports.js';
import {
  buildEditorSpawnSpec,
  CUSTOM_EDITOR_ID,
  NONE_EDITOR_ID,
  resolveEditorOption,
} from '../utils/editorOptions.js';
import { getFileExtension } from '../utils/fileUtils.js';

import { FileWatcherService } from './file-watcher.js';
import { GitDiffParser } from './git-diff.js';

import {
  type BaseMode,
  type CommentImport,
  type Comment,
  type CommentThread,
  type DiffCommentThread,
  type DiffResponse,
  type DiffSelection,
  type GeneratedStatusResponse,
  type RevisionsResponse,
} from '@/types/diff.js';
import {
  createDiffSelection,
  diffSelectionsEqual,
  getDiffSelectionKey,
} from '../utils/diffSelection.js';

export interface ReviewSessionOptions {
  selection?: DiffSelection;
  stdinDiff?: string;
  ignoreWhitespace?: boolean;
  clearComments?: boolean;
  commentImports?: CommentImport[];
  diffMode?: DiffMode;
  repoPath?: string;
  contextLines?: number;
}

export interface ReviewDiffResponse extends DiffResponse {
  ignoreWhitespace: boolean;
  openInEditorAvailable: boolean;
  baseCommitish?: string;
  targetCommitish?: string;
  requestedBaseCommitish?: string;
  requestedTargetCommitish?: string;
  requestedBaseMode?: BaseMode;
  clearComments?: boolean;
  repositoryId: string;
  commentImports?: CommentImport[];
  commentImportId?: string;
}

export interface BlobResponse {
  blob: Buffer;
  contentType: string;
}

export type ReviewSessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

interface CommentSessionState {
  threads: DiffCommentThread[];
  version: number;
}

interface EditorRequest {
  readonly id: string | undefined;
  readonly command: string | undefined;
  readonly argsTemplate: string | undefined;
}

const GENERATED_STATUS_CACHE_TTL_MS = 60_000;
const MAX_DIFF_CACHE_ENTRIES = 8;

function createDiffCacheKey(selection: DiffSelection, ignoreWhitespace: boolean) {
  return `${getDiffSelectionKey(selection)}\u0000${ignoreWhitespace ? '1' : '0'}`;
}

function getCachedDiffResponse(
  cache: Map<string, DiffResponse>,
  key: string,
): DiffResponse | undefined {
  const cached = cache.get(key);
  if (!cached) {
    return undefined;
  }

  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setCachedDiffResponse(cache: Map<string, DiffResponse>, key: string, value: DiffResponse) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    cache.delete(oldestKey);
  }
}

function parseBaseMode(value: unknown): BaseMode | undefined {
  if (value === 'merge-base') {
    return 'merge-base';
  }

  return undefined;
}

function createResolvedCommentSelection(
  responseDiffData: DiffResponse,
  fallbackSelection: DiffSelection,
  stdinDiff: boolean,
): DiffSelection {
  const baseCommitish =
    responseDiffData.baseCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.baseCommitish);
  const targetCommitish =
    responseDiffData.targetCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.targetCommitish);
  const baseMode = responseDiffData.requestedBaseMode ?? fallbackSelection.baseMode;

  return createDiffSelection(baseCommitish, targetCommitish, baseMode);
}

function createCommentSessionKey(selection: DiffSelection): string {
  return getDiffSelectionKey(selection);
}

export class ReviewSession {
  readonly repositoryPath: string;
  readonly repositoryId: string;

  private constructor(
    private readonly options: ReviewSessionOptions,
    repositoryPath: string,
    private readonly parser: GitDiffParser,
    private readonly fileWatcher: FileWatcherService,
    private readonly initialSelection: DiffSelection,
    private readonly initialDiffData: DiffResponse,
    private readonly initialCommentImports: CommentImport[],
    private readonly commentImportId: string | undefined,
    private currentSelection: DiffSelection,
    private currentCommentSelection: DiffSelection,
    private readonly generatedStatusCache: Map<
      string,
      { value: GeneratedStatusResponse; expiresAt: number }
    >,
    private readonly diffDataCache: Map<string, DiffResponse>,
    private readonly commentSessions: Map<string, CommentSessionState>,
  ) {
    this.repositoryPath = repositoryPath;
    this.repositoryId = createHash('sha256').update(repositoryPath).digest('hex');
  }

  static async create(options: ReviewSessionOptions): Promise<ReviewSession> {
    const repositoryPath = resolve(options.repoPath ?? process.cwd());
    const initialSelection = options.selection ?? createDiffSelection('', '');
    const initialCommentImports = options.commentImports || [];
    const commentImportId =
      initialCommentImports.length > 0
        ? createHash('sha256').update(serializeCommentImports(initialCommentImports)).digest('hex')
        : undefined;
    const parser = new GitDiffParser(repositoryPath);
    const fileWatcher = new FileWatcherService();
    const generatedStatusCache = new Map<
      string,
      { value: GeneratedStatusResponse; expiresAt: number }
    >();
    const diffDataCache = new Map<string, DiffResponse>();
    const initialIgnoreWhitespace = options.ignoreWhitespace || false;

    if (!options.stdinDiff) {
      const isValidCommit = await parser.validateCommit(initialSelection.targetCommitish);
      if (!isValidCommit) {
        throw new Error(`Invalid or non-existent commit: ${initialSelection.targetCommitish}`);
      }
    }

    let initialDiffData: DiffResponse;
    if (options.stdinDiff) {
      initialDiffData = parser.parseStdinDiff(options.stdinDiff);
    } else {
      initialDiffData = await parser.parseDiff(
        initialSelection,
        initialIgnoreWhitespace,
        options.contextLines,
      );
      setCachedDiffResponse(
        diffDataCache,
        createDiffCacheKey(initialSelection, initialIgnoreWhitespace),
        initialDiffData,
      );
    }

    const currentCommentSelection = createResolvedCommentSelection(
      initialDiffData,
      initialSelection,
      Boolean(options.stdinDiff),
    );
    const commentSessions = new Map<string, CommentSessionState>();
    const initialCommentThreads = mergeCommentImports([], initialCommentImports).threads;
    if (initialCommentThreads.length > 0) {
      commentSessions.set(createCommentSessionKey(currentCommentSelection), {
        threads: initialCommentThreads,
        version: 1,
      });
    }

    return new ReviewSession(
      options,
      repositoryPath,
      parser,
      fileWatcher,
      initialSelection,
      initialDiffData,
      initialCommentImports,
      commentImportId,
      initialSelection,
      currentCommentSelection,
      generatedStatusCache,
      diffDataCache,
      commentSessions,
    );
  }

  get isEmpty(): boolean {
    return this.initialDiffData.isEmpty || false;
  }

  async getDiff(query: Record<string, unknown>): Promise<ReviewDiffResponse> {
    const ignoreWhitespace = query.ignoreWhitespace === 'true';
    const requestedSelection = this.getDiffSelectionFromQuery(query);
    const shouldIncludeCommentImports =
      this.initialCommentImports.length > 0 &&
      (this.isStdinDiff() || diffSelectionsEqual(requestedSelection, this.initialSelection));
    this.currentSelection = requestedSelection;

    let responseDiffData = this.initialDiffData;
    if (!this.isStdinDiff()) {
      const cacheKey = createDiffCacheKey(requestedSelection, ignoreWhitespace);
      const cached = getCachedDiffResponse(this.diffDataCache, cacheKey);
      if (cached) {
        responseDiffData = cached;
      } else {
        responseDiffData = await this.parser.parseDiff(
          requestedSelection,
          ignoreWhitespace,
          this.options.contextLines,
        );
        setCachedDiffResponse(this.diffDataCache, cacheKey, responseDiffData);
        this.generatedStatusCache.clear();
      }
    }

    this.currentCommentSelection = createResolvedCommentSelection(
      responseDiffData,
      requestedSelection,
      this.isStdinDiff(),
    );

    const baseCommitish =
      responseDiffData.baseCommitish ?? (this.isStdinDiff() ? 'stdin' : undefined);
    const targetCommitish =
      responseDiffData.targetCommitish ?? (this.isStdinDiff() ? 'stdin' : undefined);
    const requestedBaseCommitish =
      responseDiffData.requestedBaseCommitish ??
      (requestedSelection.baseCommitish || (this.isStdinDiff() ? 'stdin' : undefined));
    const requestedTargetCommitish =
      responseDiffData.requestedTargetCommitish ??
      (requestedSelection.targetCommitish || (this.isStdinDiff() ? 'stdin' : undefined));
    const requestedBaseMode = responseDiffData.requestedBaseMode ?? requestedSelection.baseMode;

    return {
      ...responseDiffData,
      ignoreWhitespace,
      openInEditorAvailable: !this.isStdinDiff(),
      baseCommitish,
      targetCommitish,
      requestedBaseCommitish,
      requestedTargetCommitish,
      requestedBaseMode,
      clearComments: this.options.clearComments,
      repositoryId: this.repositoryId,
      commentImports: shouldIncludeCommentImports ? this.initialCommentImports : undefined,
      commentImportId: shouldIncludeCommentImports ? this.commentImportId : undefined,
    };
  }

  async getGeneratedStatus(
    filepath: unknown,
    refValue: unknown,
  ): Promise<ReviewSessionResult<GeneratedStatusResponse>> {
    if (this.isStdinDiff()) {
      return {
        ok: false,
        status: 400,
        error: 'Generated status is not available for stdin diff',
      };
    }

    const filepathResult = this.parseRepositoryRelativePath(filepath);
    if (!filepathResult.ok) {
      return { ok: false, status: 400, error: filepathResult.error };
    }
    const normalizedFilepath = filepathResult.path;
    const ref =
      (typeof refValue === 'string' && refValue) || this.currentSelection.targetCommitish || 'HEAD';
    const cacheKey = `${ref}:${normalizedFilepath}`;
    const now = Date.now();
    const cached = this.generatedStatusCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { ok: true, value: cached.value };
    }

    const status = await this.parser.getGeneratedStatus(normalizedFilepath, ref);
    const response: GeneratedStatusResponse = {
      path: normalizedFilepath,
      ref,
      ...status,
    };
    this.generatedStatusCache.set(cacheKey, {
      value: response,
      expiresAt: now + GENERATED_STATUS_CACHE_TTL_MS,
    });

    return { ok: true, value: response };
  }

  async getRevisionOptions(): Promise<ReviewSessionResult<RevisionsResponse>> {
    if (this.isStdinDiff()) {
      return {
        ok: false,
        status: 400,
        error: 'Revision selection not available for stdin diff',
      };
    }

    const { branches, commits, originDefaultBranch, resolvedBase, resolvedTarget } =
      await this.parser.getRevisionOptions(
        this.currentSelection.baseCommitish,
        this.currentSelection.targetCommitish,
      );

    return {
      ok: true,
      value: {
        specialOptions: [
          { value: '.', label: 'All Uncommitted Changes' },
          { value: 'staged', label: 'Staging Area' },
          { value: 'working', label: 'Working Directory' },
        ],
        branches,
        commits,
        originDefaultBranch,
        resolvedBase,
        resolvedTarget,
      },
    };
  }

  async getLineCount(
    filepathValue: unknown,
    oldRef: string | undefined,
    oldPathValue: unknown,
    newRef: string | undefined,
  ): Promise<ReviewSessionResult<{ oldLineCount?: number; newLineCount?: number }>> {
    if (this.isStdinDiff()) {
      return { ok: false, status: 404, error: 'Line count not available for stdin diff' };
    }

    const filepathResult = this.parseRepositoryRelativePath(filepathValue);
    if (!filepathResult.ok) {
      return { ok: false, status: 400, error: filepathResult.error };
    }
    const filepath = filepathResult.path;
    const oldPathResult = oldPathValue
      ? this.parseRepositoryRelativePath(oldPathValue)
      : { ok: true as const, path: filepath };
    if (!oldPathResult.ok) {
      return { ok: false, status: 400, error: oldPathResult.error };
    }
    const oldPath = oldPathResult.path;

    const result: { oldLineCount?: number; newLineCount?: number } = {};

    if (oldRef) {
      try {
        result.oldLineCount = await this.parser.getLineCount(oldPath, oldRef);
      } catch {
        result.oldLineCount = 0;
      }
    }
    if (newRef) {
      try {
        result.newLineCount = await this.parser.getLineCount(filepath, newRef);
      } catch {
        result.newLineCount = 0;
      }
    }

    return { ok: true, value: result };
  }

  async getBlob(
    filepathValue: unknown,
    refValue: unknown,
  ): Promise<ReviewSessionResult<BlobResponse>> {
    if (this.isStdinDiff()) {
      return { ok: false, status: 404, error: 'Blob content not available for stdin diff' };
    }

    const filepathResult = this.parseRepositoryRelativePath(filepathValue);
    if (!filepathResult.ok) {
      return { ok: false, status: 400, error: filepathResult.error };
    }
    const filepath = filepathResult.path;
    const ref = (typeof refValue === 'string' && refValue) || 'HEAD';
    const blob = await this.parser.getBlobContent(filepath, ref);
    const ext = getFileExtension(filepath);
    const contentTypes: { [key: string]: string } = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      ico: 'image/x-icon',
      tiff: 'image/tiff',
      tif: 'image/tiff',
      avif: 'image/avif',
      heic: 'image/heic',
      heif: 'image/heif',
    };

    return {
      ok: true,
      value: {
        blob,
        contentType: contentTypes[ext || ''] || 'application/octet-stream',
      },
    };
  }

  postComments(query: Record<string, unknown>, requestBody: unknown) {
    const selection = this.getCommentSelectionFromQuery(query);
    const body: unknown =
      typeof requestBody === 'string' ? (JSON.parse(requestBody) as unknown) : requestBody;
    const nextThreads = this.parseCommentsPayload(body);
    const baseVersion = this.parseBaseVersion(body);
    const session = this.getOrCreateCommentSession(selection);

    const isStale = typeof baseVersion === 'number' && baseVersion !== session.version;
    const resolvedThreads = isStale
      ? mergeCommentThreads(session.threads, nextThreads).threads
      : nextThreads;

    this.updateCommentSession(selection, resolvedThreads);

    return {
      success: true,
      merged: isStale,
      version: session.version,
      threads: session.threads,
    };
  }

  postCommentImports(query: Record<string, unknown>, requestBody: unknown) {
    const selection = this.getCommentSelectionFromQuery(query);
    const session = this.getOrCreateCommentSession(selection);
    const commentImports = this.parseCommentImportsPayload(requestBody);
    const importId = createHash('sha256')
      .update(serializeCommentImports(commentImports))
      .digest('hex');
    const merged = mergeCommentImports(session.threads, commentImports);
    const changed = this.updateCommentSession(selection, merged.threads);

    return {
      success: true,
      changed,
      count: commentImports.length,
      importId,
      warnings: merged.warnings,
    };
  }

  getCommentsJson(query: Record<string, unknown>) {
    const selection = this.getCommentSelectionFromQuery(query);
    const session = this.getOrCreateCommentSession(selection);
    return {
      version: session.version,
      threads: session.threads,
    };
  }

  getCommentsOutput(query: Record<string, unknown>): string {
    const selection = this.getCommentSelectionFromQuery(query);
    const session = this.getOrCreateCommentSession(selection);

    if (session.threads.length === 0) {
      return '';
    }

    return formatCommentsOutput(session.threads.map((thread) => this.toCommentThread(thread)));
  }

  async openInEditor(requestBody: unknown): Promise<ReviewSessionResult<{ success: true }>> {
    if (this.isStdinDiff()) {
      return { ok: false, status: 400, error: 'Open in editor is not available for stdin diff' };
    }

    const { filePath, line, editor } = (requestBody ?? {}) as {
      filePath?: unknown;
      line?: unknown;
      editor?: unknown;
    };

    if (typeof filePath !== 'string') {
      return { ok: false, status: 400, error: 'Invalid request payload' };
    }

    const filepathResult = this.parseRepositoryRelativePath(filePath);
    if (!filepathResult.ok) {
      return { ok: false, status: 400, error: filepathResult.error };
    }
    const resolvedPath = resolve(this.repositoryPath, filepathResult.path);

    const editorRequest = this.parseEditorRequest(editor);
    const editorId =
      editorRequest.id ?? process.env.DIFIT_EDITOR ?? process.env.EDITOR ?? undefined;

    if (editorId?.toLowerCase() === NONE_EDITOR_ID) {
      return { ok: false, status: 400, error: 'Open in editor is disabled' };
    }

    let command: string;
    let argsTemplate: string;
    if (editorRequest.command !== undefined || editorRequest.argsTemplate !== undefined) {
      command = (editorRequest.command ?? '').trim();
      argsTemplate = (editorRequest.argsTemplate ?? '').trim();
    } else {
      const preset = resolveEditorOption(editorId);
      command = preset.command;
      argsTemplate = preset.argsTemplate;
    }

    if (!command || !argsTemplate) {
      const isCustom = editorId?.toLowerCase() === CUSTOM_EDITOR_ID;
      return {
        ok: false,
        status: 400,
        error: isCustom
          ? 'Custom editor is not configured. Set a command and arguments in Settings > System.'
          : 'Open in editor is not configured',
      };
    }

    const lineNumber = (() => {
      const parsed = Number.parseInt(String(line ?? ''), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })();

    const spawnSpec = buildEditorSpawnSpec({
      command,
      argsTemplate,
      filePath: resolvedPath,
      lineNumber,
    });

    if (!spawnSpec) {
      return { ok: false, status: 500, error: 'Invalid editor configuration' };
    }

    const launched = await new Promise<boolean>((resolvePromise) => {
      const child = spawn(spawnSpec.command, [...spawnSpec.args], {
        stdio: 'ignore',
        detached: true,
      });
      child.once('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== 'ENOENT') {
          console.error('Failed to launch editor CLI:', error);
        }
        resolvePromise(false);
      });
      child.once('spawn', () => {
        child.unref();
        resolvePromise(true);
      });
    });

    if (!launched) {
      return {
        ok: false,
        status: 500,
        error: `Failed to launch editor: command "${spawnSpec.command}" is not available on PATH`,
      };
    }

    return { ok: true, value: { success: true } };
  }

  outputFinalComments() {
    const session = this.getOrCreateCommentSession(this.currentCommentSelection);
    if (session.threads.length > 0) {
      console.log(
        formatCommentsOutput(session.threads.map((thread) => this.toCommentThread(thread))),
      );
    }
  }

  addWatchClient(res: Response): void {
    this.fileWatcher.addClient(res);
  }

  removeWatchClient(res: Response): void {
    this.fileWatcher.removeClient(res);
  }

  async startFileWatcher(): Promise<void> {
    if (!this.options.diffMode) {
      return;
    }

    await this.fileWatcher.start(this.options.diffMode, this.repositoryPath, 300, () => {
      this.invalidateCache();
    });
  }

  async stopFileWatcher(): Promise<void> {
    await this.fileWatcher.stop();
  }

  private isStdinDiff(): boolean {
    return Boolean(this.options.stdinDiff);
  }

  private invalidateCache() {
    this.diffDataCache.clear();
    this.generatedStatusCache.clear();
    this.parser.clearResolvedCommitCache();
  }

  private getDiffSelectionFromQuery(query: Record<string, unknown>): DiffSelection {
    const hasBase = typeof query.base === 'string';
    const hasTarget = typeof query.target === 'string';
    const hasBaseMode = typeof query.baseMode === 'string';
    return createDiffSelection(
      hasBase ? (query.base as string) : this.currentSelection.baseCommitish,
      hasTarget ? (query.target as string) : this.currentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : this.currentSelection.baseMode,
    );
  }

  private parseRepositoryRelativePath(
    filepath: unknown,
  ):
    | { ok: true; path: string }
    | { ok: false; error: 'Invalid file path' | 'File path outside repository' } {
    if (typeof filepath !== 'string' || filepath.length === 0) {
      return { ok: false, error: 'Invalid file path' };
    }

    const normalizedFilepath = filepath.replace(/\\/g, '/');
    const hasParentTraversal = normalizedFilepath.split('/').some((segment) => segment === '..');
    if (isAbsolute(filepath) || normalizedFilepath.startsWith('/') || hasParentTraversal) {
      return { ok: false, error: 'File path outside repository' };
    }

    const resolvedPath = resolve(this.repositoryPath, normalizedFilepath);
    if (
      resolvedPath !== this.repositoryPath &&
      !resolvedPath.startsWith(`${this.repositoryPath}${sep}`)
    ) {
      return { ok: false, error: 'File path outside repository' };
    }

    return { ok: true, path: normalizedFilepath };
  }

  private parseEditorRequest(value: unknown): EditorRequest {
    if (!value || typeof value !== 'object') {
      return { id: undefined, command: undefined, argsTemplate: undefined };
    }
    const candidate = value as {
      id?: unknown;
      command?: unknown;
      argsTemplate?: unknown;
    };
    return {
      id: typeof candidate.id === 'string' ? candidate.id : undefined,
      command: typeof candidate.command === 'string' ? candidate.command : undefined,
      argsTemplate: typeof candidate.argsTemplate === 'string' ? candidate.argsTemplate : undefined,
    };
  }

  private getCommentSelectionFromQuery(query: Record<string, unknown>): DiffSelection {
    const hasBase = typeof query.base === 'string';
    const hasTarget = typeof query.target === 'string';
    const hasBaseMode = typeof query.baseMode === 'string';

    if (!hasBase && !hasTarget && !hasBaseMode) {
      return this.currentCommentSelection;
    }

    return createDiffSelection(
      hasBase ? (query.base as string) : this.currentCommentSelection.baseCommitish,
      hasTarget ? (query.target as string) : this.currentCommentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : this.currentCommentSelection.baseMode,
    );
  }

  private getOrCreateCommentSession(selection: DiffSelection): CommentSessionState {
    const key = createCommentSessionKey(selection);
    const existing = this.commentSessions.get(key);
    if (existing) {
      return existing;
    }

    const nextSession: CommentSessionState = {
      threads: [],
      version: 0,
    };
    this.commentSessions.set(key, nextSession);
    return nextSession;
  }

  private normalizeLineValue(line: unknown): DiffCommentThread['position']['line'] {
    if (Array.isArray(line) && line.length === 2) {
      const start = line[0] as unknown;
      const end = line[1] as unknown;
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start > 0 &&
        end > 0 &&
        start <= end
      ) {
        return { start, end };
      }
    }

    if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
      return line;
    }

    return 1;
  }

  private normalizeComment(comment: Comment): DiffCommentThread {
    const now = new Date().toISOString();
    const timestamp = typeof comment.timestamp === 'string' ? comment.timestamp : now;
    const threadId =
      typeof comment.id === 'string' && comment.id.length > 0
        ? comment.id
        : createHash('sha256').update(JSON.stringify(comment)).digest('hex').slice(0, 12);
    const filePath =
      typeof comment.file === 'string' && comment.file.length > 0 ? comment.file : '<unknown file>';

    return {
      id: threadId,
      filePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      position: {
        side: comment.side ?? 'new',
        line: this.normalizeLineValue(comment.line),
      },
      codeSnapshot:
        typeof comment.codeContent === 'string'
          ? {
              content: comment.codeContent,
            }
          : undefined,
      messages: [
        {
          id: threadId,
          body: comment.body,
          author: comment.author,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
  }

  private toCommentThread(thread: DiffCommentThread): CommentThread {
    return {
      id: thread.id,
      file: thread.filePath,
      line:
        typeof thread.position.line === 'number'
          ? thread.position.line
          : ([thread.position.line.start, thread.position.line.end] as [number, number]),
      side: thread.position.side,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      codeContent: thread.codeSnapshot?.content,
      messages: thread.messages,
    };
  }

  private normalizeThreadPayload(thread: CommentThread | DiffCommentThread): DiffCommentThread {
    if ('filePath' in thread && 'position' in thread) {
      return thread;
    }

    const threadId =
      typeof thread.id === 'string' && thread.id.length > 0
        ? thread.id
        : createHash('sha256').update(JSON.stringify(thread)).digest('hex').slice(0, 12);
    const now = new Date().toISOString();
    const messages =
      Array.isArray(thread.messages) && thread.messages.length > 0
        ? thread.messages.map((message, index) => ({
            id:
              typeof message.id === 'string' && message.id.length > 0
                ? message.id
                : `${threadId}:${index}`,
            body: message.body,
            author: message.author,
            createdAt: message.createdAt || thread.createdAt || now,
            updatedAt: message.updatedAt || message.createdAt || thread.updatedAt || now,
          }))
        : [
            {
              id: threadId,
              body: '',
              createdAt: thread.createdAt || now,
              updatedAt: thread.updatedAt || thread.createdAt || now,
            },
          ];
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    return {
      id: threadId,
      filePath:
        typeof thread.file === 'string' && thread.file.length > 0 ? thread.file : '<unknown file>',
      createdAt: thread.createdAt || firstMessage?.createdAt || now,
      updatedAt: thread.updatedAt || lastMessage?.updatedAt || thread.createdAt || now,
      position: {
        side: thread.side ?? 'new',
        line: this.normalizeLineValue(thread.line),
      },
      codeSnapshot:
        typeof thread.codeContent === 'string'
          ? {
              content: thread.codeContent,
            }
          : undefined,
      messages,
    };
  }

  private parseCommentsPayload(body: unknown): DiffCommentThread[] {
    const payload =
      typeof body === 'string'
        ? (JSON.parse(body) as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          })
        : (body as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          });

    if (Array.isArray(payload.threads)) {
      return payload.threads.map((thread) => this.normalizeThreadPayload(thread));
    }

    if (Array.isArray(payload.comments)) {
      return payload.comments.map((comment) => this.normalizeComment(comment));
    }

    return [];
  }

  private parseBaseVersion(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = (payload as { baseVersion?: unknown }).baseVersion;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  private parseCommentImportsPayload(body: unknown): CommentImport[] {
    if (typeof body === 'string') {
      return normalizeCommentImports(JSON.parse(body));
    }

    return normalizeCommentImports(body);
  }

  private updateCommentSession(
    selection: DiffSelection,
    nextThreads: DiffCommentThread[],
  ): boolean {
    const session = this.getOrCreateCommentSession(selection);
    const previous = JSON.stringify(session.threads);
    const next = JSON.stringify(nextThreads);
    session.threads = nextThreads;

    if (previous === next) {
      return false;
    }

    session.version += 1;
    this.fileWatcher.broadcast({
      type: 'commentsChanged',
      version: session.version,
      timestamp: new Date().toISOString(),
    });
    return true;
  }
}
