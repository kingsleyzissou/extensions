export interface GitIdentity {
  user: {
    name: string;
    email: string;
  };
}

export interface SandboxProjectConfig {
  image: string;
  tag: string;
  pinned: boolean;
  lastDigest: string | null;
  lastCheckedAt: number | null;
  git: GitIdentity | null;
}
