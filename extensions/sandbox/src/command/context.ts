import type { PathApprovalStore } from '../path-approvals';
import type { Sandbox } from '../types/index';

export interface SandboxCommandDependencies {
  localCwd: string;
  getSbx: () => Sandbox | null;
  pathApprovals: PathApprovalStore | null;
}
