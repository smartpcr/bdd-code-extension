import { resolve } from './portablePath';

/** A path key that compares equal for the same file however VS Code or Node spelled it. */
export function fileKey(p: string): string {
  return lowerDrive(resolve(p));
}

/** A Windows drive letter in lower case; any other path unchanged. */
export function lowerDrive(p: string): string {
  return /^[A-Za-z]:/.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
}
