// The lint status in the status bar (plan B2.3, B2.4, B2.6).
import * as vscode from 'vscode';

export class SuiteStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('bddSuite.status', vscode.StatusBarAlignment.Left, 10);
  /** The last text shown, for tests. */
  text = '';

  constructor() {
    this.item.name = 'Suite Authoring';
    this.item.command = 'bddSuite.configureLint';
  }

  private show(text: string, warning: boolean): void {
    this.text = text;
    this.item.text = `${warning ? '$(warning) ' : ''}${text}`;
    this.item.backgroundColor = warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  setOk(tool: string, target: string): void {
    this.show(`Suite: lint ${tool} -> ${target}`, false);
  }

  setFailure(text: string): void {
    this.show(text, true);
  }

  setUntrusted(): void {
    this.show('Suite: untrusted, lint and run disabled', true);
  }

  dispose(): void {
    this.item.dispose();
  }
}
