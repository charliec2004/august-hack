/** GET /api/computer: August's computer as a workspace (Screen, Terminal, Files). */

export type ComputerBrowser = {
  sessionId: string;
  /** 'user': opened from the panel (closable there). 'august': a task's browser. */
  owner: "user" | "august";
  /** Title of the task this browser belongs to, if any. */
  taskTitle: string | null;
  /** Kernel interactive live view (watch + take control). */
  liveViewUrl: string;
  /** False when another session holds the profile, so sign-ins here aren't saved. */
  savesSignIns: boolean;
  openedAt: string;
};

export type ComputerCommand = {
  id: string;
  command: string;
  exitCode: number | null;
  output: string;
  createdAt: string;
};

export type ComputerFile = {
  id: string;
  filename: string;
  mediaType: string;
  byteCount: number;
  createdAt: string;
};

export type ComputerWorkspace = {
  /** Whether August's Linux computer can be started. */
  available: boolean;
  /** "billing" when the Fly account blocks new computers. */
  blockedBy: "billing" | "not_configured" | "unreachable" | null;
  tools: string[];
  browsers: ComputerBrowser[];
  commands: ComputerCommand[];
  files: ComputerFile[];
};

/** POST /api/computer/exec. */
export type ComputerExecResult =
  | { status: "ran"; command: ComputerCommand }
  | { status: "blocked"; blockedBy: ComputerWorkspace["blockedBy"]; message: string }
  | { status: "failed"; message: string };
