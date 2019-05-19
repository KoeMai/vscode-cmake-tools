/**
 * Module for the legacy driver. Talks to pre-CMake Server versions of CMake.
 * Can also talk to newer versions of CMake via the command line.
 */ /** */

import {CMakeExecutable} from '@cmt/cmake/cmake-executable';
import {DirectoryContext} from '@cmt/workspace';
import * as vscode from 'vscode';

import * as api from './api';
import {CMakeCache} from './cache';
import {CMakeDriver, CMakePreconditionProblemSolver} from './driver';
import {Kit, CMakeGenerator} from './kit';
// import * as proc from './proc';
import * as logging from './logging';
import {fs} from './pr';
import * as proc from './proc';
import rollbar from './rollbar';
import * as util from './util';

const log = logging.createLogger('legacy-driver');

/**
 * The legacy driver.
 */
export class LegacyCMakeDriver extends CMakeDriver {
  private constructor(cmake: CMakeExecutable, readonly ws: DirectoryContext, workspaceRootPath: string | null, preconditionHandler: CMakePreconditionProblemSolver) {
    super(cmake, ws, workspaceRootPath, preconditionHandler);
  }

  private _needsReconfigure = true;
  doConfigureSettingsChange() { this._needsReconfigure = true; }
  async checkNeedsReconfigure(): Promise<boolean> { return this._needsReconfigure; }

  async doSetKit(need_clean: boolean, cb: () => Promise<void>): Promise<void> {
    this._needsReconfigure = true;
    if (need_clean) {
      await this._cleanPriorConfiguration();
    }
    await cb();
  }

  // Legacy disposal does nothing
  async asyncDispose() { this._cacheWatcher.dispose(); }

  async doConfigure(args_: string[], outputConsumer?: proc.OutputConsumer): Promise<number> {
    // Dup args so we can modify them
    const args = Array.from(args_);
    args.push('-H' + util.lightNormalizePath(this.sourceDir));
    const bindir = util.lightNormalizePath(this.binaryDir);
    args.push('-B' + bindir);
    const gen = this.generator;
    if (gen) {
      args.push(`-G${gen.name}`);
      if (gen.toolset) {
        args.push(`-T${gen.toolset}`);
      }
      if (gen.platform) {
        args.push(`-A${gen.platform}`);
      }
    }
    const cmake = this.cmake.path;
    log.debug('Invoking CMake', cmake, 'with arguments', JSON.stringify(args));
    const env = await this.getConfigureEnvironment();
    const res = await this.executeCommand(cmake, args, outputConsumer, {environment: env}).result;
    log.trace(res.stderr);
    log.trace(res.stdout);
    if (res.retc == 0) {
      this._needsReconfigure = false;
    }
    await this._reloadPostConfigure();
    return res.retc === null ? -1 : res.retc;
  }

  protected async doPreCleanConfigure(): Promise<void> {
    await this._cleanPriorConfiguration();
  }

  async doPostBuild(): Promise<boolean> {
    await this._reloadPostConfigure();
    return true;
  }

  async doInit() {
    if (await fs.exists(this.cachePath)) {
      await this._reloadPostConfigure();
    }
    this._cacheWatcher.onDidChange(() => {
      log.debug(`Reload CMake cache: ${this.cachePath} changed`);
      rollbar.invokeAsync('Reloading CMake Cache', () => this._reloadPostConfigure());
    });
  }

  static async create(cmake: CMakeExecutable, ws: DirectoryContext, kit: Kit|null, workspaceRootPath: string | null, preconditionHandler: CMakePreconditionProblemSolver, preferedGenerators: CMakeGenerator[]): Promise<LegacyCMakeDriver> {
    log.debug('Creating instance of LegacyCMakeDriver');
    return this.createDerived(new LegacyCMakeDriver(cmake, ws, workspaceRootPath, preconditionHandler), kit, preferedGenerators);
  }

  get targets() { return []; }
  get executableTargets() { return []; }

  /**
   * Watcher for the CMake cache file on disk.
   */
  private readonly _cacheWatcher = vscode.workspace.createFileSystemWatcher(this.cachePath);

  get cmakeCache() { return this._cmakeCache; }
  private _cmakeCache: CMakeCache|null = null;

  private async _reloadPostConfigure() {
    // Force await here so that any errors are thrown into rollbar
    const new_cache = await CMakeCache.fromPath(this.cachePath);
    this._cmakeCache = new_cache;
  }

  get cmakeCacheEntries() {
    let ret = new Map<string, api.CacheEntryProperties>();
    if (this.cmakeCache) {
      ret = util.reduce(this.cmakeCache.allEntries, ret, (acc, entry) => acc.set(entry.key, entry));
    }
    return ret;
  }

  get generatorName(): string|null {
    if (!this.cmakeCache) {
      return null;
    }
    const gen = this.cmakeCache.get('CMAKE_GENERATOR');
    return gen ? gen.as<string>() : null;
  }
}
