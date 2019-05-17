import * as chai from 'chai';
import { expect } from 'chai';
import * as chaiString from 'chai-string';
import * as path from 'path';
import * as fs from 'fs';

import * as cms_driver from '@cmt/cms-driver';
import { FakeContextDefinition } from '@test/helpers/vscodefake/extensioncontext';
import { ConfigurationReader } from '@cmt/config';
import { DirectoryContext } from '@cmt/workspace';
import { StateManager } from '@cmt/state';
import { getCMakeExecutableInformation } from '@cmt/cmake/cmake-executable';

chai.use(chaiString);

import { Kit } from '@cmt/kit';

const here = __dirname;
function getTestRootFilePath(filename: string): string {
  return path.normalize(path.join(here, "../../../..", filename));
}

// tslint:disable:no-unused-expression

suite.only('CMake-Server-Driver tests', () => {
  test('All target for gcc', async () => {
    const root = getTestRootFilePath('test/unit-tests/cms-driver/workspace');
    const project_root = getTestRootFilePath('test/unit-tests/cms-driver/workspace/test_project');
    const vsContext = new FakeContextDefinition();
    const config = ConfigurationReader.createForDirectory(root);
    const wsContext = new DirectoryContext(project_root, config, new StateManager(vsContext));
    const executeable = await getCMakeExecutableInformation("cmake");

    const k = {
      name: "Visual Studio Community 2017 - amd64",
      visualStudio: "VisualStudio.15.0",
      visualStudioArchitecture: "amd64",
      preferredGenerator: {
        name: "Visual Studio 15 2017 Win64",
        platform: "x64"
      }
    } as Kit;

    const d = await cms_driver.CMakeServerClientDriver.create(executeable, wsContext, k, project_root);
    const allTargetName = d.allTargetName;
    expect(allTargetName).to.eq('ALL_BUILD');

    d.dispose();
  }).timeout(100000);

  test('Check binary dir', async () => {
    const root = getTestRootFilePath('test/unit-tests/cms-driver/workspace');
    const project_root = getTestRootFilePath('test/unit-tests/cms-driver/workspace/test_project');
    const vsContext = new FakeContextDefinition();
    const config = ConfigurationReader.createForDirectory(root);
    const wsContext = new DirectoryContext(project_root, config, new StateManager(vsContext));
    const executeable = await getCMakeExecutableInformation("cmake");

    const k = {
      name: "Visual Studio Community 2017 - amd64",
      visualStudio: "VisualStudio.15.0",
      visualStudioArchitecture: "amd64",
      preferredGenerator: {
        name: "Visual Studio 15 2017 Win64",
        platform: "x64"
      }
    } as Kit;

    const d = await cms_driver.CMakeServerClientDriver.create(executeable, wsContext, k, project_root);
    expect(d.binaryDir).to.endsWith('test/unit-tests/cms-driver/workspace/test_project/build');
    d.dispose();
  }).timeout(10000000);


  test('Build', async () => {
    const root = getTestRootFilePath('test/unit-tests/cms-driver/workspace');
    const project_root = getTestRootFilePath('test/unit-tests/cms-driver/workspace/test_project');
    const vsContext = new FakeContextDefinition();
    const config = ConfigurationReader.createForDirectory(root);
    const wsContext = new DirectoryContext(project_root, config, new StateManager(vsContext));
    const executeable = await getCMakeExecutableInformation("cmake");

    const k = {
      name: "Visual Studio Community 2017 - amd64",
      visualStudio: "VisualStudio.15.0",
      visualStudioArchitecture: "amd64",
      preferredGenerator: {
        name: "Visual Studio 15 2017 Win64",
        platform: "x64"
      }
    } as Kit;

    const d = await cms_driver.CMakeServerClientDriver.create(executeable, wsContext, k, project_root);
    expect(await d.cleanConfigure()).to.be.eq(0);
    expect(await d.build(d.allTargetName)).to.be.eq(0);

    expect(d.executableTargets.length).to.be.eq(1);
    expect(d.executableTargets[0].name).to.be.equal("TestBuildProcess");
    expect(fs.existsSync(d.executableTargets[0].path)).to.be.true;
    d.dispose();
  }).timeout(10000000);
});
