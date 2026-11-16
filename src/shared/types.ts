export type ToolKind = 'plugin' | 'skill' | 'command' | 'connector';

/**
 * Each status names what the evidence proves, nothing more:
 * discovered = a file or config entry was found; installed = an installer
 * registry lists it; enabled/disabled = the platform reports its switch;
 * connected = a live connection check succeeded.
 */
export type ToolStatus =
  | 'available'
  | 'discovered'
  | 'installed'
  | 'enabled'
  | 'disabled'
  | 'configured'
  | 'connected'
  | 'needs-auth'
  | 'not-configured'
  | 'unverified';

export type ToolScope = 'user' | 'project' | 'local' | 'managed' | 'account' | 'catalog' | 'unknown';

export type EnvId = 'claude' | 'claude-code' | 'chatgpt' | 'codex' | 'gemini' | 'antigravity';

/** State of one tool in one environment and scope. */
export interface EnvPlacement {
  env: EnvId;
  scope: ToolScope;
  status: ToolStatus;
  evidence: string;
}

export interface Evidence {
  /** Where the status came from, e.g. the CLI command or the file that was read. */
  source: string;
  checkedAt: string;
}

export type CommandKind = 'usage' | 'install' | 'auth';

export interface CommandHint {
  kind: CommandKind;
  label: string;
  text: string;
  where: string;
}

export interface ArabicNotes {
  summary: string;
  when: string;
  example: string;
  /** True when the text is a category template, not written for this tool. */
  generic: boolean;
}

/** Direct install of a catalog plugin through the Claude CLI. */
export interface CatalogInstall {
  /** Arguments passed to `claude`. Built in the main process, never from user input. */
  args: string[];
  plugin: string;
  /** True when the plugin is downloaded from a repository Anthropic does not host. */
  thirdParty: boolean;
  origin: string;
}

export interface Tool {
  id: string;
  kind: ToolKind;
  name: string;
  title: string;
  category: string;
  /** Strongest status across environments. */
  status: ToolStatus;
  statusNote?: string;
  scope: ToolScope;
  source: string;
  inCatalog: boolean;
  /** True when the tool exists on this computer or account, not only in a catalog. */
  mine: boolean;
  envs: EnvPlacement[];
  evidence: Evidence;
  description: string;
  ar: ArabicNotes;
  parentId?: string;
  related: string[];
  commands: CommandHint[];
  docsUrl?: string;
  version?: string;
  location?: string;
  install?: CatalogInstall;
}

export interface AccountInfo {
  /** null when the state could not be read. */
  loggedIn: boolean | null;
  method?: string;
  email?: string;
  organization?: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export type SourceState = 'ok' | 'degraded' | 'failed';

export interface SourceHealth {
  id: string;
  env: EnvId | 'catalog';
  label: string;
  state: SourceState;
  message: string;
  evidence: string;
  checkedAt: string;
  /** Date of the data being shown when it is older than this check. */
  dataDate?: string;
  setupUrl?: string;
}

export type CapabilityState = 'verified' | 'needs-completion' | 'unverified';

export interface PlatformCapability {
  key: 'inventory' | 'install' | 'sync' | 'login';
  label: string;
  state: CapabilityState;
  detail: string;
  evidence: string;
}

export interface PlatformInfo {
  env: EnvId;
  detected: boolean;
  version?: string;
  capabilities: PlatformCapability[];
  officialUrl: string;
}

export interface Snapshot {
  generatedAt: string;
  cliVersion: string | null;
  projectDir: string | null;
  account: AccountInfo;
  tools: Tool[];
  sources: SourceHealth[];
  platforms: PlatformInfo[];
}

// ---------- Install plans ----------

export type PlanItemKind = 'plugin' | 'skill' | 'extension' | 'connector';

export type DestinationState = 'ready' | 'exists' | 'needs-completion' | 'unsupported';

export interface PlanDestination {
  env: EnvId;
  state: DestinationState;
  /** Why this destination is or is not compatible with the item. */
  evidence: string;
  /** What will happen, in words. */
  action: string;
  scope: string;
  /** Exact command or target path, shown before anything runs. */
  detail?: string;
  officialUrl?: string;
}

export interface PlanItem {
  id: string;
  kind: PlanItemKind;
  name: string;
  description: string;
  /** Path inside the source repository. */
  path: string;
  destinations: PlanDestination[];
}

export interface InstallPlan {
  id: string;
  sourceKind: 'catalog' | 'git';
  source: string;
  thirdParty: boolean;
  items: PlanItem[];
  note?: string;
}

export interface PlanPick {
  itemId: string;
  env: EnvId;
}

export interface PlanResult extends PlanPick {
  ok: boolean;
  /** True when a fresh inventory check found the tool after installing. */
  verified: boolean;
  message: string;
}

export type PlanResponse = { ok: true; plan: InstallPlan } | { ok: false; message: string };

export interface ClaudeAddsApi {
  load(): Promise<Snapshot>;
  copy(text: string): Promise<boolean>;
  open(url: string): Promise<boolean>;
  chooseProject(): Promise<string | null>;
  clearProject(): Promise<void>;
  /** Opens a terminal running `claude auth login`. The app never sees credentials. */
  login(): Promise<ActionResult>;
  /** Clones a Git repository to a temporary folder and lists what it contains. */
  planFromGit(url: string): Promise<PlanResponse>;
  planFromTool(toolId: string): Promise<PlanResponse>;
  runPlan(planId: string, picks: PlanPick[]): Promise<PlanResult[]>;
}
