export type ToolKind = 'plugin' | 'skill' | 'connector';

export type ToolStatus =
  | 'available'
  | 'enabled'
  | 'disabled'
  | 'configured'
  | 'connected'
  | 'needs-auth'
  | 'not-configured'
  | 'unverified';

export type ToolScope = 'user' | 'project' | 'local' | 'managed' | 'account' | 'catalog' | 'unknown';

export interface Evidence {
  /** Where the status came from, e.g. the CLI command or the file that was read. */
  source: string;
  checkedAt: string;
}

export type CommandKind = 'usage' | 'install' | 'auth' | 'prereq';

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

export interface Tool {
  id: string;
  kind: ToolKind;
  isCommand?: boolean;
  name: string;
  title: string;
  category: string;
  status: ToolStatus;
  statusNote?: string;
  scope: ToolScope;
  source: string;
  inCatalog: boolean;
  evidence: Evidence;
  description: string;
  ar: ArabicNotes;
  parentId?: string;
  related: string[];
  commands: CommandHint[];
  docsUrl?: string;
  version?: string;
  location?: string;
  /** Present when the tool can be installed from the app through the Claude CLI. */
  install?: InstallPlan;
}

export interface InstallPlan {
  /** Arguments passed to `claude`. Built in the main process, never from user input. */
  args: string[];
  /** Plugin that gets installed (the parent, for skills and connectors). */
  plugin: string;
  /** True when the plugin is downloaded from a repository Anthropic does not host. */
  thirdParty: boolean;
  origin: string;
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

export type SourceId = 'cli' | 'account' | 'plugins' | 'skills' | 'connectors' | 'catalog';
export type SourceState = 'ok' | 'degraded' | 'failed';

export interface SourceHealth {
  id: SourceId;
  label: string;
  state: SourceState;
  message: string;
  evidence: string;
  checkedAt: string;
  /** Date of the data being shown when it is older than this check (cached catalog). */
  dataDate?: string;
  setupUrl?: string;
}

export interface Snapshot {
  generatedAt: string;
  cliVersion: string | null;
  projectDir: string | null;
  account: AccountInfo;
  tools: Tool[];
  sources: SourceHealth[];
}

export interface ClaudeAddsApi {
  load(): Promise<Snapshot>;
  /** Installs the plugin behind this tool with `claude plugin install`. */
  install(toolId: string): Promise<ActionResult>;
  /** Opens a terminal running `claude auth login`. The app never sees credentials. */
  login(): Promise<ActionResult>;
  copy(text: string): Promise<boolean>;
  open(url: string): Promise<boolean>;
  chooseProject(): Promise<string | null>;
  clearProject(): Promise<void>;
}
