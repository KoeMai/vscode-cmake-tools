/**
 * Module for the legacy driver. Talks to pre-CMake Server versions of CMake.
 * Can also talk to newer versions of CMake via the command line.
 */ /** */

import * as api from '@cmt/api';
import {ExecutableTarget} from '@cmt/api';
import {CMakeExecutable} from '@cmt/cmake/cmake-executable';
import {ConfigurationReader} from '@cmt/config';
import * as index_api from '@cmt/drivers/cmakefileapi/api';
import {loadCacheContent, loadIndexFile} from '@cmt/drivers/cmakefileapi/api_helpers';
import {CMakeDriver, CMakePreconditionProblemSolver} from '@cmt/drivers/driver';
import {CMakeGenerator, Kit} from '@cmt/kit';
import * as logging from '@cmt/logging';
import {fs} from '@cmt/pr';
import * as proc from '@cmt/proc';
import rollbar from '@cmt/rollbar';
import * as util from '@cmt/util';
import {Exception} from 'handlebars';
import * as path from 'path';
import * as vscode from 'vscode';

const log = logging.createLogger('cmakefileapi-driver');
/**
 * The cmake driver with FileApi of CMake >3.15.0
 */
export class CMakeFileApiDriver extends CMakeDriver {
  private constructor(cmake: CMakeExecutable,
                      readonly config: ConfigurationReader,
                      workspaceRootPath: string|null,
                      preconditionHandler: CMakePreconditionProblemSolver) {
    super(cmake, config, workspaceRootPath, preconditionHandler);
  }

  static async create(cmake: CMakeExecutable,
                      config: ConfigurationReader,
                      kit: Kit|null,
                      workspaceRootPath: string|null,
                      preconditionHandler: CMakePreconditionProblemSolver,
                      preferedGenerators: CMakeGenerator[]): Promise<CMakeFileApiDriver> {
    log.debug('Creating instance of CMakeFileApiDriver');
    return this.createDerived(new CMakeFileApiDriver(cmake, config, workspaceRootPath, preconditionHandler),
                              kit,
                              preferedGenerators);
  }

  private _needsReconfigure = true;
  private _cache: Map<string, api.CacheEntry> = new Map<string, api.CacheEntry>();
  private _generatorInformation: index_api.Index.GeneratorInformation|null = null;
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
    const api_path = this.getCMakeFileApiPath();
    await createQueryFileForApi(api_path);

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

  /**
   * Watcher for the CMake cache file on disk.
   */
  private readonly _cacheWatcher = vscode.workspace.createFileSystemWatcher(this.cachePath);

  private getCMakeFileApiPath() { return path.join(this.binaryDir, '.cmake', 'api', 'v1'); }

  private async _reloadPostConfigure() {
    const api_path = this.getCMakeFileApiPath();
    const reply_path = path.join(api_path, 'reply');
    const indexFile = await loadIndexFile(reply_path);
    this._generatorInformation = indexFile.cmake.generator;

    const cache_obj = indexFile.objects.find((value: index_api.Index.ObjectKind) => value.kind === 'cache');
    if (!cache_obj) {
      throw Exception('No cache object found');
    }

    this._cache = await loadCacheContent(path.join(reply_path, cache_obj.jsonFile));
  }

  get cmakeCacheEntries(): Map<string, api.CacheEntryProperties> { return this._cache; }

  get generatorName(): string|null { return this._generatorInformation ? this._generatorInformation.name : null; }

  get targets() { return []; }

  get executableTargets(): ExecutableTarget[] { return []; }
}

async function createQueryFileForApi(api_path: string): Promise<string> {
  const query_path = path.join(api_path, 'query', 'client-vscode');
  const query_file_path = path.join(query_path, 'query.json');
  await fs.mkdir_p(query_path);

  const requests
      = {requests: [{kind: 'cache', version: 2}, {kind: 'codemodel', version: 2}, {kind: 'cmakeFiles', version: 1}]};

  await fs.writeFile(query_file_path, JSON.stringify(requests));
  return query_file_path;
}