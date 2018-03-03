import * as path from 'path';
import * as vscode from 'vscode';

import {CMakeTools} from '../src/cmake-tools';

import paths from '../src/paths';
import {fs} from '../src/pr';

export async function clearExistingKitConfigurationFile() {
  await fs.writeFile(path.join(paths.dataDir, 'cmake-kits.json'), "[]");
}

export async function getExtension() {
  const cmt = vscode.extensions.getExtension<CMakeTools>('vector-of-bool.cmake-tools');
  if (!cmt) {
    throw new Error("Extension doesn't exist");
  }
  return cmt.isActive ? Promise.resolve(cmt.exports) : cmt.activate();
}