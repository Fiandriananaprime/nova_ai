import path from 'node:path';
import { execa } from 'execa';
import { NovaError } from '../utils/errors.js';
import { assertSafeAgentDirectory, assertSafeAgentPath } from '../security/agent-files.js';

export class AuxiliaryGitRepository {
  readonly gitDir: string;
  constructor(readonly projectRoot: string, directory = '.nova_agents/history.git') {
    const normalized = directory.replaceAll('\\', '/');
    const candidate = path.resolve(projectRoot, normalized);
    const relative = path.relative(path.resolve(projectRoot), candidate).replaceAll('\\', '/');
    if (path.isAbsolute(normalized) || relative === '.nova_agents' || !relative.startsWith('.nova_agents/')) {
      throw new NovaError('Le dépôt auxiliaire doit obligatoirement rester sous .nova_agents/ ; le dépôt Git principal ne sera jamais ciblé.', 'AUX_GIT_PATH_FORBIDDEN');
    }
    this.gitDir = candidate;
  }

  private args(args: string[]): string[] {
    return [`--git-dir=${this.gitDir}`, `--work-tree=${this.projectRoot}`, ...args];
  }

  async run(args: string[], allowFailure = false): Promise<string> {
    await assertSafeAgentPath(this.gitDir);
    const result = await execa('git', this.args(args), { cwd: this.projectRoot, reject: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.exitCode !== 0 && !allowFailure) {
      throw new NovaError(`Échec Git auxiliaire (${args.join(' ')}): ${(result.stderr || result.stdout).trim()}`, 'AUX_GIT_FAILED');
    }
    return result.stdout.trim();
  }

  async initialize(): Promise<void> {
    await assertSafeAgentDirectory(path.dirname(this.gitDir), true);
    await assertSafeAgentPath(this.gitDir);
    const { execa: exec } = await import('execa');
    const init = await exec('git', ['init', '--bare', '--quiet', this.gitDir], { cwd: this.projectRoot, reject: false, windowsHide: true });
    if (init.exitCode !== 0) throw new NovaError(`Impossible d'initialiser l'historique Git auxiliaire : ${init.stderr}`, 'AUX_GIT_INIT_FAILED');
    await this.run(['config', 'core.bare', 'false']);
    await this.run(['config', 'user.name', 'Nova Agent']);
    await this.run(['config', 'user.email', 'nova-agent@localhost']);
    await this.run(['config', 'core.autocrlf', 'false']);
  }

  async exists(): Promise<boolean> {
    try { return (await this.run(['rev-parse', '--git-dir'])).length > 0; } catch { return false; }
  }

  async head(): Promise<string | null> {
    const head = await this.run(['rev-parse', 'HEAD'], true);
    return /^[0-9a-f]{40,64}$/i.test(head) ? head : null;
  }

  async snapshot(relativePaths: string[]): Promise<string | null> {
    const before = await this.head();
    await this.addPaths(relativePaths);
    await this.run(['commit', '--allow-empty', '-m', 'agent: initial project snapshot']);
    const after = await this.head();
    if (!after) throw new NovaError('Le snapshot initial n’a pas créé de commit auxiliaire.', 'AUX_GIT_SNAPSHOT_FAILED');
    return after && after !== before ? after : after;
  }

  async commitFiles(relativePaths: string[], message: string): Promise<{ before: string | null; after: string | null }> {
    const before = await this.head();
    if (!relativePaths.length) return { before, after: before };
    await this.addPaths(relativePaths);
    // `git diff --cached --quiet` returns exit code 0 when nothing staged changed.
    const check = await execa('git', this.args(['diff', '--cached', '--quiet']), { cwd: this.projectRoot, reject: false, windowsHide: true });
    if (check.exitCode === 0) return { before, after: before };
    await this.run(['commit', '-m', message]);
    return { before, after: await this.head() };
  }

  private async addPaths(relativePaths: string[]): Promise<void> {
    const paths = dedupe(relativePaths);
    for (let index = 0; index < paths.length; index += 100) {
      await this.run(['add', '--', ...paths.slice(index, index + 100)]);
    }
  }

  async status(): Promise<string> { return this.run(['status', '--short'], true); }
  async log(max = 20): Promise<string> { return this.run(['log', `-${max}`, '--date=iso-strict', '--pretty=format:%h%x09%ad%x09%s'], true); }
}

function dedupe(items: string[]): string[] { return [...new Set(items)]; }
