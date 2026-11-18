import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

// External path approval store (persisted across sessions)
// ---------------------------------------------------------------------------

export interface PathApprovalRecord {
  path: string;
  approvedAt: number;
  expiresAt: number; // Infinity = forever
}

export class PathApprovalStore {
  private path: string;
  private records: Map<string, PathApprovalRecord> = new Map();

  constructor(agentDir: string) {
    this.path = resolvePath(agentDir, 'path-approvals.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as PathApprovalRecord[];
      const now = Date.now();
      for (const r of raw) {
        if (r.expiresAt === Infinity || r.expiresAt > now) {
          this.records.set(r.path, r);
        }
      }
    } catch {
      // corrupt file — start fresh
    }
  }

  private save(): void {
    const dir = this.path.slice(0, this.path.lastIndexOf('/'));
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
    const tmpPath = this.path + '.tmp';
    const data = Array.from(this.records.values());
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.path);
  }

  /** Check if a path (or any parent prefix) is approved. Returns the matching record or undefined. */
  find(absPath: string): PathApprovalRecord | undefined {
    // Exact match
    const exact = this.records.get(absPath);
    if (exact && (exact.expiresAt === Infinity || exact.expiresAt > Date.now())) return exact;

    // Prefix match (e.g. approved /foo/bar matches /foo/bar/baz.txt)
    for (const [, record] of this.records) {
      if (
        (absPath === record.path || absPath.startsWith(record.path + '/')) &&
        (record.expiresAt === Infinity || record.expiresAt > Date.now())
      ) {
        return record;
      }
    }

    return undefined;
  }

  add(absPath: string, days: number | typeof Infinity): void {
    const now = Date.now();
    const record: PathApprovalRecord = {
      path: absPath,
      approvedAt: now,
      expiresAt: days === Infinity ? Infinity : now + days * 24 * 60 * 60 * 1000,
    };
    this.records.set(absPath, record);
    this.save();
  }

  revoke(absPath: string): boolean {
    if (this.records.delete(absPath)) {
      this.save();
      return true;
    }
    return false;
  }

  list(): PathApprovalRecord[] {
    return Array.from(this.records.values()).filter(
      r => r.expiresAt === Infinity || r.expiresAt > Date.now(),
    );
  }
}

// ---------------------------------------------------------------------------

// Interactive approval flow for external paths
// ---------------------------------------------------------------------------

/**
 * Check if a host path needs approval and request it interactively.
 * Returns true if approved (path is added to the session allowlist), false if denied.
 */
export async function requestPathApproval(
  absPath: string,
  sessionPrefixes: string[],
  store: PathApprovalStore,
  ui: ExtensionUIContext,
): Promise<boolean> {
  // 1. Check session-level prefixes (--container-allow-paths, /sandbox allow)
  for (const prefix of sessionPrefixes) {
    if (absPath === prefix || absPath.startsWith(prefix + '/')) return true;
  }

  // 2. Check persisted approvals
  const existing = store.find(absPath);
  if (existing) return true;

  // 3. Default: pi clipboard files (auto-approved)
  const basename = absPath.split('/').pop() || '';
  if (basename.startsWith('pi-clipboard-')) return true;

  // 4. Interactive approval
  const options = [
    `Approve once`,
    `Approve always`,
    `Approve for 7 days`,
    `Approve for 30 days`,
    `Deny`,
  ];

  let choice: string | undefined;
  try {
    choice = await ui.select(`Sandbox: External File Access`, options);
  } catch {
    return false;
  }

  if (!choice || choice.includes('Deny')) return false;

  if (choice.includes('once')) {
    // Session-only, not persisted — add to session prefixes
    sessionPrefixes.push(absPath);
    return true;
  }

  if (choice.includes('always')) {
    store.add(absPath, Infinity);
    sessionPrefixes.push(absPath);
    ui.notify(`Approved read access (always): ${absPath}`, 'info');
    return true;
  }

  const days = choice.includes('30') ? 30 : 7;
  store.add(absPath, days);
  sessionPrefixes.push(absPath);
  ui.notify(`Approved read access (${days} days): ${absPath}`, 'info');
  return true;
}

// ---------------------------------------------------------------------------
