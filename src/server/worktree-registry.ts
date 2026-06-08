import { access, mkdir, readFile, realpath, rename, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, resolve, sep, delimiter } from 'path';

import { simpleGit } from 'simple-git';

import { type BaseMode } from '../types/diff.js';

export interface WorktreeRegistration {
  id: string;
  path: string;
  base: string;
  target: string;
  baseMode?: BaseMode;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeRegistrationView extends WorktreeRegistration {
  missing: boolean;
}

export interface WorktreeRegistrationInput {
  id?: unknown;
  path?: unknown;
  base?: unknown;
  target?: unknown;
  baseMode?: unknown;
  name?: unknown;
}

export interface WorktreeRegistryOptions {
  storagePath?: string;
  trustedRoots?: string[];
  now?: () => Date;
}

interface RegistryFile {
  worktrees: WorktreeRegistration[];
}

export class WorktreeRegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const WORKTREE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAX_REF_LENGTH = 512;

function getDefaultWorktreeRegistryPath(): string {
  return join(homedir(), '.config', 'difit-hub', 'worktrees.json');
}

function getDefaultTrustedRoots(): string[] {
  const envRoots = process.env.DIFIT_HUB_TRUSTED_ROOTS?.split(delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (envRoots && envRoots.length > 0) {
    return envRoots;
  }

  return [homedir(), process.cwd(), tmpdir()];
}

function isPathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function parseWorktreeId(value: unknown): string {
  if (typeof value !== 'string' || !WORKTREE_ID_PATTERN.test(value)) {
    throw new WorktreeRegistryError(
      400,
      'Worktree id must be URL-safe and contain only letters, numbers, underscores, or hyphens',
    );
  }

  return value;
}

function parseOptionalName(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new WorktreeRegistryError(400, 'Worktree name must be a string');
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRefValue(value: unknown, fieldName: 'base' | 'target', fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new WorktreeRegistryError(400, `Worktree ${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_REF_LENGTH ||
    trimmed.startsWith('-') ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new WorktreeRegistryError(400, `Worktree ${fieldName} is not a valid revision value`);
  }

  return trimmed;
}

function parseBaseMode(value: unknown): BaseMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'merge-base') {
    return 'merge-base';
  }

  throw new WorktreeRegistryError(400, 'Worktree baseMode must be "merge-base" when provided');
}

function parseRegistrationFile(value: unknown): RegistryFile {
  const candidate = value as { worktrees?: unknown };
  const worktrees = Array.isArray(value)
    ? value
    : Array.isArray(candidate.worktrees)
      ? candidate.worktrees
      : undefined;

  if (!worktrees) {
    throw new Error('Invalid worktree registry file');
  }

  return {
    worktrees: worktrees.map((entry) => {
      const candidateEntry = entry as WorktreeRegistration;
      if (
        typeof candidateEntry.id !== 'string' ||
        typeof candidateEntry.path !== 'string' ||
        typeof candidateEntry.base !== 'string' ||
        typeof candidateEntry.target !== 'string' ||
        typeof candidateEntry.createdAt !== 'string' ||
        typeof candidateEntry.updatedAt !== 'string'
      ) {
        throw new Error('Invalid worktree registry entry');
      }

      return candidateEntry;
    }),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class WorktreeRegistry {
  private registrations = new Map<string, WorktreeRegistration>();
  private trustedRoots: string[] = [];

  private constructor(
    private readonly storagePath: string,
    private readonly options: WorktreeRegistryOptions,
  ) {}

  static async create(options: WorktreeRegistryOptions = {}): Promise<WorktreeRegistry> {
    const registry = new WorktreeRegistry(
      resolve(options.storagePath ?? getDefaultWorktreeRegistryPath()),
      options,
    );
    registry.trustedRoots = await registry.resolveTrustedRoots(
      options.trustedRoots ?? getDefaultTrustedRoots(),
    );
    await registry.load();
    return registry;
  }

  async list(): Promise<WorktreeRegistrationView[]> {
    const values = [...this.registrations.values()];
    return Promise.all(values.map((registration) => this.toView(registration)));
  }

  async get(idValue: unknown): Promise<WorktreeRegistrationView> {
    const id = parseWorktreeId(idValue);
    const registration = this.registrations.get(id);
    if (!registration) {
      throw new WorktreeRegistryError(404, 'Worktree registration not found');
    }

    return await this.toView(registration);
  }

  getStored(idValue: unknown): WorktreeRegistration {
    const id = parseWorktreeId(idValue);
    const registration = this.registrations.get(id);
    if (!registration) {
      throw new WorktreeRegistryError(404, 'Worktree registration not found');
    }

    return registration;
  }

  async register(input: WorktreeRegistrationInput): Promise<WorktreeRegistrationView> {
    const id = parseWorktreeId(input.id);
    if (this.registrations.has(id)) {
      throw new WorktreeRegistryError(409, 'Worktree id is already registered');
    }
    if (input.path === undefined) {
      throw new WorktreeRegistryError(400, 'Worktree path is required');
    }

    const now = this.nowIso();
    const registration: WorktreeRegistration = {
      id,
      path: await this.resolveGitWorktreePath(input.path),
      base: parseRefValue(input.base, 'base', 'HEAD'),
      target: parseRefValue(input.target, 'target', '.'),
      baseMode: parseBaseMode(input.baseMode),
      name: parseOptionalName(input.name),
      createdAt: now,
      updatedAt: now,
    };

    this.registrations.set(id, registration);
    await this.persist();
    return await this.toView(registration);
  }

  async patch(
    idValue: unknown,
    input: WorktreeRegistrationInput,
  ): Promise<WorktreeRegistrationView> {
    const id = parseWorktreeId(idValue);
    const current = this.registrations.get(id);
    if (!current) {
      throw new WorktreeRegistryError(404, 'Worktree registration not found');
    }
    if (input.id !== undefined && input.id !== id) {
      throw new WorktreeRegistryError(400, 'Worktree id cannot be changed');
    }

    const next: WorktreeRegistration = {
      ...current,
      path: input.path === undefined ? current.path : await this.resolveGitWorktreePath(input.path),
      base: parseRefValue(input.base, 'base', current.base),
      target: parseRefValue(input.target, 'target', current.target),
      baseMode: input.baseMode === undefined ? current.baseMode : parseBaseMode(input.baseMode),
      name: input.name === undefined ? current.name : parseOptionalName(input.name),
      updatedAt: this.nowIso(),
    };

    this.registrations.set(id, next);
    await this.persist();
    return await this.toView(next);
  }

  async delete(idValue: unknown): Promise<void> {
    const id = parseWorktreeId(idValue);
    if (!this.registrations.delete(id)) {
      throw new WorktreeRegistryError(404, 'Worktree registration not found');
    }

    await this.persist();
  }

  async isMissing(registration: WorktreeRegistration): Promise<boolean> {
    return !(await pathExists(registration.path));
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.storagePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    const parsed = parseRegistrationFile(JSON.parse(text) as unknown);
    this.registrations = new Map(
      parsed.worktrees.map((registration) => [registration.id, registration]),
    );
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true });
    const payload: RegistryFile = {
      worktrees: [...this.registrations.values()],
    };
    const tempPath = `${this.storagePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.storagePath);
  }

  private async toView(registration: WorktreeRegistration): Promise<WorktreeRegistrationView> {
    return {
      ...registration,
      missing: await this.isMissing(registration),
    };
  }

  private async resolveTrustedRoots(roots: string[]): Promise<string[]> {
    const resolvedRoots: string[] = [];
    for (const root of roots) {
      try {
        resolvedRoots.push(await realpath(resolve(root)));
      } catch {
        resolvedRoots.push(resolve(root));
      }
    }

    return resolvedRoots;
  }

  private async resolveGitWorktreePath(pathValue: unknown): Promise<string> {
    if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
      throw new WorktreeRegistryError(400, 'Worktree path must be a non-empty string');
    }

    if (!isAbsolute(pathValue)) {
      throw new WorktreeRegistryError(400, 'Worktree path must be absolute');
    }
    const requestedPath = resolve(pathValue);

    let requestedRealPath: string;
    try {
      requestedRealPath = await realpath(requestedPath);
    } catch {
      throw new WorktreeRegistryError(400, 'Worktree path does not exist');
    }

    if (!this.isTrustedPath(requestedRealPath)) {
      throw new WorktreeRegistryError(403, 'Worktree path is outside trusted local paths');
    }

    try {
      const git = simpleGit(requestedRealPath);
      const isInsideWorktree = (await git.revparse(['--is-inside-work-tree'])).trim() === 'true';
      if (!isInsideWorktree) {
        throw new WorktreeRegistryError(400, 'Worktree path is not a git worktree');
      }

      const topLevel = (await git.revparse(['--show-toplevel'])).trim();
      const repositoryPath = await realpath(topLevel);
      if (!this.isTrustedPath(repositoryPath)) {
        throw new WorktreeRegistryError(403, 'Worktree path is outside trusted local paths');
      }

      return repositoryPath;
    } catch (error) {
      if (error instanceof WorktreeRegistryError) {
        throw error;
      }
      throw new WorktreeRegistryError(400, 'Worktree path is not a git worktree');
    }
  }

  private isTrustedPath(path: string): boolean {
    return this.trustedRoots.some((root) => isPathWithinRoot(path, root));
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
