// The workspace-trust gate (plan B2.6, INV-11). The host passes in how to ask
// VS Code; everything that runs workspace code calls the gate itself.

export interface TrustGate {
  canRunWorkspaceCode(): boolean;
  /** Text for the status bar when the gate is shut. */
  readonly untrustedText: string;
}

export function createTrustGate(isTrusted: () => boolean): TrustGate {
  return {
    canRunWorkspaceCode: () => isTrusted(),
    untrustedText: 'Suite: untrusted, lint and run disabled',
  };
}
