// A newer copy of this extension installed while the window is open (by
// `npm run install:local`, `code --install-extension` or the Extensions view)
// runs only after the window reloads, because VS Code loads an extension's code
// once per extension host. This watches the extensions folder and, when a newer
// copy appears, offers the reload: a status bar button that stays until the
// reload, and a notification. It never reloads by itself: a reload restarts
// every extension in the window, so its moment is the user's.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { newerInstalled } from '../core/selfUpdate';

/** Long enough for an install to finish unpacking before the folder is read. */
const SETTLE_MS = 1500;

export function watchForUpdate(context: vscode.ExtensionContext, log: (line: string) => void): vscode.Disposable {
  const id = context.extension.id;
  const running = String(context.extension.packageJSON.version);
  const dir = path.dirname(context.extensionPath);
  // Only an installed copy (<id>-<version> in an extensions folder); a
  // development host runs from the source tree and has nothing to compare.
  if (path.basename(context.extensionPath).toLowerCase() !== `${id}-${running}`.toLowerCase()) return new vscode.Disposable(() => undefined);

  const item = vscode.window.createStatusBarItem('bddSuite.update', vscode.StatusBarAlignment.Left, 1000);
  item.name = 'Suite Authoring update';
  item.command = 'workbench.action.reloadWindow';
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  let offered: string | undefined;

  const check = () => {
    let folders: string[];
    try {
      folders = fs.readdirSync(dir).filter(f => fs.existsSync(path.join(dir, f, 'package.json')));
    } catch {
      return;
    }
    let obsolete = new Set<string>();
    try {
      obsolete = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.obsolete'), 'utf8'))));
    } catch {
      // no .obsolete file: nothing is awaiting deletion
    }
    const newer = newerInstalled(folders, obsolete, id, running);
    if (!newer || newer === offered) return;
    offered = newer;
    log(`Suite Authoring ${newer} is installed; this window runs ${running} until it reloads.`);
    item.text = `$(sync) Reload for Suite Authoring ${newer}`;
    item.tooltip = `Suite Authoring ${newer} is installed, but this window still runs ${running}. Click to reload the window and load it.`;
    item.show();
    void vscode.window.showInformationMessage(`Suite Authoring ${newer} was installed. This window still runs ${running} until it reloads.`, 'Reload window')
      .then(pick => {
        if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
  };

  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => {
      clearTimeout(timer);
      timer = setTimeout(check, SETTLE_MS);
    });
    watcher.on('error', () => undefined);
  } catch {
    // the folder cannot be watched; the check at activation still runs
  }
  check();
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    watcher?.close();
    item.dispose();
  });
}
