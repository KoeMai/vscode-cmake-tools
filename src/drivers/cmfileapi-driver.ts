import * as api from '@cmt/api';
import {ExecutableTarget} from '@cmt/api';
import {CMakeCache} from '@cmt/cache';
import {CMakeExecutable} from '@cmt/cmake/cmake-executable';
import {ConfigurationReader} from '@cmt/config';
import * as index_api from '@cmt/drivers/cmakefileapi/api';
import {
  createQueryFileForApi,
  loadCacheContent,
  loadConfigurationTargetMap,
  loadExtCodeModelContent,
  loadIndexFile
} from '@cmt/drivers/cmakefileapi/api_helpers';
import * as codemodel from '@cmt/drivers/codemodel-driver-interface';
import {CMakePreconditionProblemSolver} from '@cmt/drivers/driver';
import {CMakeGenerator, Kit} from '@cmt/kit';
import * as logging from '@cmt/logging';
import {fs} from '@cmt/pr';
import * as proc from '@cmt/proc';
import rollbar from '@cmt/rollbar';
import * as util from '@cmt/util';
import * as path from 'path';
import * as vscode from 'vscode';

import {NoGeneratorError} from './cms-driver';

const log = logging.createLogger('cmakefileapi-driver');
/**
 * The CMake driver with FileApi of CMake >= 3.15.0
 */
export class CMakeFileApiDriver extends codemodel.CodeModelDriver {
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
                      preferredGenerators: CMakeGenerator[]): Promise<CMakeFileApiDriver> {
    log.debug('Creating instance of CMakeFileApiDriver');
    return this.createDerived(new CMakeFileApiDriver(cmake, config, workspaceRootPath, preconditionHandler),
                              kit,
                              preferredGenerators);
  }

  private _needsReconfigure = true;

  /**
   * Watcher for the CMake cache file on disk.
   */
  private readonly _cacheWatcher = vscode.workspace.createFileSystemWatcher(this.cachePath);

  // Information from cmake file api
  private _cache: Map<string, api.CacheEntry> = new Map<string, api.CacheEntry>();
  private _generatorInformation: index_api.Index.GeneratorInformation|null = null;
  private _target_map: Map<string, api.Target[]> = new Map();

  async loadGeneratorInformationFromCache(cache_file_path: string) {
    const cache = await CMakeCache.fromPath(cache_file_path);

    this._generator = {
      name: cache.get('CMAKE_GENERATOR')!.value,
      toolset: cache.get('CMAKE_GENERATOR_PLATFORM') ? cache.get('CMAKE_GENERATOR_PLATFORM')!.value : undefined,
      platform: cache.get('CMAKE_GENERATOR_TOOLSET') ? cache.get('CMAKE_GENERATOR_TOOLSET')!.value : undefined
    } as CMakeGenerator;

    this._generatorInformation = {
      name: cache.get('CMAKE_GENERATOR')!.value,
      platform: cache.get('CMAKE_GENERATOR_TOOLSET') ? cache.get('CMAKE_GENERATOR_TOOLSET')!.value : undefined
    };
  }

  async doInit() {
    // The seems to be a different between server mode and fileapi on load of a existing project
    // If the existing project is not generated by the IDE then the fileapi queries are missing.
    // but the generator information are needed to get the code mode, cache and cmake files.
    // This workaround load the information from cache.
    if (await fs.exists(this.cachePath)) {
      await this.loadGeneratorInformationFromCache(this.cachePath);
      await this.doConfigure([], undefined);
    } else {
      this._generatorInformation = this.generator;
    }
    if (!this.generator) {
      throw new NoGeneratorError();
    }

    this._cacheWatcher.onDidChange(() => {
      log.debug(`Reload CMake cache: ${this.cachePath} changed`);
      rollbar.invokeAsync('Reloading CMake Cache', () => this.updateCodeModel());
    });
  }

  doConfigureSettingsChange() { this._needsReconfigure = true; }
  async checkNeedsReconfigure(): Promise<boolean> { return this._needsReconfigure; }

  async doSetKit(need_clean: boolean, cb: () => Promise<void>): Promise<void> {
    this._needsReconfigure = true;
    if (need_clean) {
      await this._cleanPriorConfiguration();
    }
    await cb();
    if (!this.generator) {
      throw new NoGeneratorError();
    }
  }

  async asyncDispose() {
    this._codeModelChanged.dispose();
    this._cacheWatcher.dispose();
  }

  protected async doPreCleanConfigure(): Promise<void> { await this._cleanPriorConfiguration(); }

  async doConfigure(args_: string[], outputConsumer?: proc.OutputConsumer): Promise<number> {
    const api_path = this.getCMakeFileApiPath();
    await createQueryFileForApi(api_path);

    // Dup args so we can modify them
    const args = Array.from(args_);
    args.push(`-H${util.lightNormalizePath(this.sourceDir)}`);
    const bindir = util.lightNormalizePath(this.binaryDir);
    args.push(`-B${bindir}`);
    const gen = this.generator;
    if (gen) {
      args.push('-G');
      args.push(gen.name);
      if (gen.toolset) {
        args.push('-T');
        args.push(gen.toolset);
      }
      if (gen.platform) {
        args.push('-A');
        args.push(gen.platform);
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
    await this.updateCodeModel();
    return res.retc === null ? -1 : res.retc;
  }

  async doPostBuild(): Promise<boolean> {
    await this.updateCodeModel();
    return true;
  }

  private getCMakeFileApiPath() { return path.join(this.binaryDir, '.cmake', 'api', 'v1'); }
  private getCMakeReplyPath() {
    const api_path = this.getCMakeFileApiPath();
    return path.join(api_path, 'reply');
  }

  private async updateCodeModel() {
    const reply_path = this.getCMakeReplyPath();
    const indexFile = await loadIndexFile(reply_path);
    if (indexFile) {
      this._generatorInformation = indexFile.cmake.generator;

      // load cache
      const cache_obj = indexFile.objects.find((value: index_api.Index.ObjectKind) => value.kind === 'cache');
      if (!cache_obj) {
        throw Error('No cache object found');
      }

      this._cache = await loadCacheContent(path.join(reply_path, cache_obj.jsonFile));

      // load targets
      const codemodel_obj = indexFile.objects.find((value: index_api.Index.ObjectKind) => value.kind === 'codemodel');
      if (!codemodel_obj) {
        throw Error('No code model object found');
      }
      this._target_map = await loadConfigurationTargetMap(reply_path, codemodel_obj.jsonFile);
      this._codeModel = await loadExtCodeModelContent(reply_path, codemodel_obj.jsonFile);
      this._codeModelChanged.fire(this._codeModel);
    }
  }

  private _codeModel: codemodel.CodeModelContent|null = null;

  get cmakeCacheEntries(): Map<string, api.CacheEntryProperties> { return this._cache; }
  get generatorName(): string|null { return this._generatorInformation ? this._generatorInformation.name : null; }
  get targets(): api.Target[] {
    const targets = this._target_map.get(this.currentBuildType);
    if (targets) {
      const metaTargets = [{
        type: 'rich' as 'rich',
        name: this.allTargetName,
        filepath: 'A special target to build all available targets',
        targetType: 'META'
      }];
      return [...metaTargets, ...targets].filter((value, idx, self) => self.findIndex(e => value.name === e.name)
                                                     === idx);
    } else {
      return [];
    }
  }

  get executableTargets(): ExecutableTarget[] {
    return this.targets.filter(t => t.type === 'rich' && (t as api.RichTarget).targetType === 'EXECUTABLE')
        .map(t => ({
               name: t.name,
               path: (t as api.RichTarget).filepath,
             }));
  }

  private readonly _codeModelChanged = new vscode.EventEmitter<null|codemodel.CodeModelContent>();
  get onCodeModelChanged() { return this._codeModelChanged.event; }
}
