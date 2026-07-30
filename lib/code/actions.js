'use server';

import { auth } from '../auth/index.js';
import { getCommandPrompt } from '../git-commands.js';
import {
  createCodeWorkspace as dbCreateCodeWorkspace,
  getCodeWorkspaceById,
  getCodeWorkspacesByUser,
  updateCodeWorkspaceTitle,
  updateContainerName,
  toggleCodeWorkspaceStarred,
  deleteCodeWorkspace as dbDeleteCodeWorkspace,
  updateHasChanges,
} from '../db/code-workspaces.js';
import {
  getChatByWorkspaceId,
  touchChatUpdatedAt,
} from '../db/chats.js';
import { buildCodingAgentSystemPrompt } from '../ai/system-prompt.js';
import { resolveAgentScope } from '../ai/scope.js';
import { workspaceDir as getWorkspaceDir } from '../tools/docker.js';
import {
  addSession,
  getSession as getTermSession,
  getSessions,
  removeSession,
  getNextPort,
  clearWorkspaceSessions,
} from './terminal-sessions.js';
import { addForward, removeForward, getForwards, clearWorkspaceForwards } from './port-forwards.js';

const RECOVERABLE_STATES = new Set(['exited', 'created', 'paused']);
const WORKSPACE_ROOT = '/home/coding-agent/workspace';

/**
 * Get the authenticated user or throw.
 */
async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }
  return session.user;
}

/**
 * Get all code workspaces for the authenticated user.
 * @returns {Promise<object[]>}
 */
export async function getCodeWorkspaces() {
  const user = await requireAuth();
  return getCodeWorkspacesByUser(user.id);
}

/**
 * Create a new code workspace.
 * @param {string} containerName - Docker container DNS name
 * @param {string} [title='Code Workspace']
 * @returns {Promise<object>}
 */
export async function createCodeWorkspace(containerName, title = 'Code Workspace') {
  const user = await requireAuth();
  return dbCreateCodeWorkspace(user.id, { containerName, title });
}

/**
 * Rename a code workspace (with ownership check).
 * @param {string} id
 * @param {string} title
 * @returns {Promise<{success: boolean}>}
 */
export async function renameCodeWorkspace(id, title) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }
  updateCodeWorkspaceTitle(id, title);
  return { success: true };
}

/**
 * Toggle a code workspace's starred status (with ownership check).
 * @param {string} id
 * @returns {Promise<{success: boolean, starred?: number}>}
 */
export async function starCodeWorkspace(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }
  const starred = toggleCodeWorkspaceStarred(id);
  return { success: true, starred };
}

/**
 * Delete a code workspace (with ownership check).
 * @param {string} id
 * @returns {Promise<{success: boolean}>}
 */
export async function deleteCodeWorkspace(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }

  // Clean up container if running
  if (workspace.containerName) {
    try {
      const { removeContainer } = await import('../tools/docker.js');
      await removeContainer(workspace.containerName);
    } catch {}
  }

  // Clean up workspace directory
  const { removeWorkspaceDir } = await import('../tools/docker.js');
  removeWorkspaceDir(id);

  dbDeleteCodeWorkspace(id);
  return { success: true };
}

/**
 * Ensure a code workspace's Docker container is running.
 * Recovers stopped/removed containers automatically.
 * @param {string} id - Workspace ID
 * @returns {Promise<{status: string, message?: string}>}
 */
export async function ensureCodeWorkspaceContainer(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { status: 'error', message: 'Workspace not found' };
  }

  if (!workspace.containerName) {
    return { status: 'no_container' };
  }

  // Inject agent job secrets when the linked chat is in agent mode
  const chat = getChatByWorkspaceId(id);
  const isAgent = chat?.chatMode === 'agent';
  const injectSecrets = isAgent;

  // Resolve scope for system prompt skills
  const wsBaseDir = getWorkspaceDir(id);
  const repoDir = (await import('path')).join(wsBaseDir, 'workspace');
  const wsScope = workspace.scope || null;
  const { skillsDir } = resolveAgentScope(repoDir, wsScope);
  const systemPrompt = buildCodingAgentSystemPrompt(isAgent ? 'agent' : 'code', isAgent ? skillsDir : null, isAgent ? wsScope : null);

  try {
    const { inspectContainer, startContainer, removeContainer, runInteractiveContainer } =
      await import('../tools/docker.js');

    const info = await inspectContainer(workspace.containerName);

    if (!info) {
      // Container not found — recreate using the agent that was originally chosen at launch time
      await runInteractiveContainer({
        containerName: workspace.containerName,
        codingAgent: workspace.codingAgent || undefined,
        repo: workspace.repo,
        branch: workspace.branch,
        featureBranch: workspace.featureBranch,
        workspaceId: id,
        injectSecrets,
        systemPrompt,
        scope: workspace.scope || undefined,
        userId: workspace.userId,
      });
      return { status: 'created' };
    }

    const state = info.State?.Status;

    if (state === 'running') {
      return { status: 'running' };
    }

    if (RECOVERABLE_STATES.has(state)) {
      try {
        await startContainer(workspace.containerName);
        return { status: 'started' };
      } catch {
        // Start failed — fall through to remove + recreate
      }
    }

    // Dead, bad state, or start failed — remove and recreate using the originally chosen agent
    await removeContainer(workspace.containerName);
    await runInteractiveContainer({
      containerName: workspace.containerName,
      codingAgent: workspace.codingAgent || undefined,
      repo: workspace.repo,
      branch: workspace.branch,
      featureBranch: workspace.featureBranch,
      workspaceId: id,
      injectSecrets,
      systemPrompt,
      scope: workspace.scope || undefined,
      userId: workspace.userId,
    });
    return { status: 'created' };
  } catch (err) {
    console.error(`[ensureCodeWorkspaceContainer] workspace=${id}`, err);
    return { status: 'error', message: err.message };
  }
}

/**
 * Start interactive mode: create a Docker container for the workspace.
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, containerName?: string, message?: string}>}
 */
export async function startInteractiveMode(id, agentOverride) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, message: 'Workspace not found' };
  }

  if (workspace.containerName) {
    return { success: true, containerName: workspace.containerName, message: 'Already running' };
  }

  // Inject agent job secrets when the linked chat is in agent mode
  const chat = getChatByWorkspaceId(id);
  const isAgent = chat?.chatMode === 'agent';
  const injectSecrets = isAgent;

  // Resolve scope for system prompt skills
  const wsBase = getWorkspaceDir(id);
  const repoPath = (await import('path')).join(wsBase, 'workspace');
  const wsScope2 = workspace.scope || null;
  const { skillsDir: scopedSkillsDir } = resolveAgentScope(repoPath, wsScope2);
  const systemPrompt = buildCodingAgentSystemPrompt(isAgent ? 'agent' : 'code', isAgent ? scopedSkillsDir : null, isAgent ? wsScope2 : null);

  try {
    const { getConfig } = await import('../config.js');
    // Use the explicitly chosen agent, then fall back to the global config default
    const agent = agentOverride || getConfig('CODING_AGENT') || 'opencode';
    const shortId = id.replace(/-/g, '').slice(0, 8);
    const containerName = `${agent}-interactive-${shortId}`;

    const { runInteractiveContainer } = await import('../tools/docker.js');
    await runInteractiveContainer({
      containerName,
      codingAgent: agent,
      repo: workspace.repo,
      branch: workspace.branch,
      featureBranch: workspace.featureBranch,
      workspaceId: id,
      injectSecrets,
      systemPrompt,
      scope: workspace.scope || undefined,
      userId: workspace.userId,
    });

    // Persist both the container name and the agent so recovery can use the same image
    updateContainerName(id, containerName, agent);
    return { success: true, containerName };
  } catch (err) {
    console.error(`[startInteractiveMode] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Get git status from a running interactive container.
 * @param {string} id - Workspace ID
 * @returns {Promise<{uncommitted: string, commits: string, unpushed: string, hasUnsavedWork: boolean, headCommit: string}|null>}
 */
export async function getContainerGitStatus(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id || !workspace.containerName) {
    return null;
  }

  try {
    const { execInContainer } = await import('../tools/docker.js');

    const baseBranch = workspace.branch || 'main';
    // Use lastInteractiveCommit for context range (only new commits), fall back to baseBranch
    const contextRef = workspace.lastInteractiveCommit || baseBranch;

    const [statusOut, headOut, logOut, unpushedOut] = await Promise.all([
      execInContainer(workspace.containerName, 'cd /home/coding-agent/workspace && git status --short 2>/dev/null'),
      execInContainer(workspace.containerName, 'cd /home/coding-agent/workspace && git rev-parse HEAD 2>/dev/null'),
      execInContainer(workspace.containerName, `cd /home/coding-agent/workspace && git log --format="- %h %s" ${contextRef}..HEAD 2>/dev/null`),
      execInContainer(workspace.containerName, `cd /home/coding-agent/workspace && git log --oneline @{u}..HEAD 2>/dev/null`).catch(() => null),
    ]);

    if (statusOut === null && logOut === null) return null;

    const uncommitted = (statusOut || '').trim();
    const commits = (logOut || '').trim();
    const headCommit = (headOut || '').trim();
    const unpushed = unpushedOut !== null
      ? (unpushedOut || '').trim()
      : commits;

    return {
      uncommitted,
      commits,
      unpushed,
      hasUnsavedWork: uncommitted.length > 0 || unpushed.length > 0,
      headCommit,
    };
  } catch (err) {
    console.error(`[getContainerGitStatus] workspace=${id}`, err);
    return null;
  }
}

/**
 * Close interactive mode: stop+remove the container, clear containerName.
 * Volume is preserved so the workspace can be reopened with existing state.
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, chatId?: string, message?: string}>}
 */
export async function closeInteractiveMode(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, message: 'Workspace not found' };
  }

  if (!workspace.containerName) {
    return { success: true, message: 'No container running' };
  }

  try {
    const { removeContainer } = await import('../tools/docker.js');

    await removeContainer(workspace.containerName);
    clearWorkspaceSessions(id);
    clearWorkspaceForwards(id);
    updateContainerName(id, null);

    const linkedChat = getChatByWorkspaceId(id);
    return { success: true, chatId: linkedChat?.id || null };
  } catch (err) {
    console.error(`[closeInteractiveMode] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Scan a container for running ttyd processes via a single pgrep exec.
 * Returns an array of { pid, port, type } for extra tabs (excludes port 7681 primary).
 * @param {string} containerName
 * @param {Function} execInContainer
 * @returns {Promise<Array<{pid: number, port: number, type: string}>>}
 */
async function scanContainerTtyd(containerName, execInContainer) {
  const raw = await execInContainer(containerName, 'pgrep -a ttyd 2>/dev/null || true');
  if (!raw || !raw.trim()) return [];

  const results = [];
  for (const line of raw.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const pid = parseInt(trimmed.split(/\s+/)[0], 10);
    if (isNaN(pid)) continue;

    const portMatch = trimmed.match(/-p\s+(\d+)/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1], 10);
    if (port === 7681) continue; // skip primary tab

    const type = (trimmed.includes('claude') || trimmed.includes(' pi') || trimmed.includes('gemini') || trimmed.includes('codex') || trimmed.includes('opencode')) ? 'code' : 'shell';
    results.push({ pid, port, type });
  }

  return results;
}

/**
 * Create a new shell terminal session inside the workspace container.
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, sessionId?: string, label?: string, message?: string}>}
 */
export async function createTerminalSession(id, type = 'shell') {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id || !workspace.containerName) {
    return { success: false, message: 'Workspace not found' };
  }

  try {
    const { execInContainer } = await import('../tools/docker.js');

    // Scan for live ttyd processes to avoid port conflicts with orphaned sessions
    const scanned = await scanContainerTtyd(workspace.containerName, execInContainer);
    const scannedPorts = new Set(scanned.map(s => s.port));

    const port = getNextPort(id, scannedPorts);
    if (!port) {
      return { success: false, message: 'Too many terminal sessions' };
    }

    const { randomUUID } = await import('crypto');

    // Start ttyd in the background, then find its PID via pgrep
    // Use the agent the workspace was originally launched with — not the current global config,
    // which may have changed since the container was started (causing wrong script path = session error)
    const { getConfig } = await import('../config.js');
    const agent = workspace.codingAgent || getConfig('CODING_AGENT') || 'opencode';
    const command = type === 'code'
      ? `nohup env PORT=${port} /scripts/common/start-ttyd-session.sh /scripts/agents/${agent}/start-coding-session.sh > /dev/null 2>&1 &`
      : `nohup env PORT=${port} /scripts/common/start-shell-session.sh > /dev/null 2>&1 &`;
    await execInContainer(
      workspace.containerName,
      command,
      10000,
    );

    // Wait for ttyd to bind
    await new Promise((r) => setTimeout(r, 800));

    const pidOut = await execInContainer(workspace.containerName, `pgrep -f "ttyd.*-p ${port}"`);
    if (!pidOut || !pidOut.trim()) {
      return { success: false, message: 'Failed to start shell' };
    }

    const pid = parseInt(pidOut.trim(), 10);
    if (isNaN(pid)) {
      return { success: false, message: 'Failed to start shell' };
    }

    const sessionId = randomUUID().slice(0, 8);
    const label = type === 'code'
      ? `Code ${port - 7680}` // port 7682 = Code 2, 7683 = Code 3, etc. (primary is Code 1 on 7681)
      : `Shell ${port - 7680}`;

    addSession(id, sessionId, { port, pid, label, type, createdAt: Date.now() });

    return { success: true, sessionId, label, type };
  } catch (err) {
    console.error(`[createTerminalSession] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Close a shell terminal session.
 * @param {string} id - Workspace ID
 * @param {string} sessionId - Session ID
 * @returns {Promise<{success: boolean}>}
 */
export async function closeTerminalSession(id, sessionId) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }

  const session = getTermSession(id, sessionId);
  if (!session) {
    return { success: false };
  }

  try {
    const { execInContainer } = await import('../tools/docker.js');
    await execInContainer(workspace.containerName, `kill ${session.pid} 2>/dev/null`);
  } catch {
    // Best effort
  }

  removeSession(id, sessionId);
  return { success: true };
}

/**
 * List terminal sessions for a workspace by scanning the container for live ttyd processes.
 * Reconciles with the in-memory registry: preserves labels for known sessions,
 * discovers orphaned sessions (e.g. after server restart), and prunes dead entries.
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, sessions?: Array<{id: string, label: string, type: string}>}>}
 */
export async function listTerminalSessions(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, sessions: [] };
  }

  if (!workspace.containerName) {
    clearWorkspaceSessions(id);
    return { success: true, sessions: [] };
  }

  try {
    const { execInContainer } = await import('../tools/docker.js');
    const { randomUUID } = await import('crypto');

    // Single exec to discover all live ttyd processes
    const scanned = await scanContainerTtyd(workspace.containerName, execInContainer);

    // Build port→scanned map for quick lookup
    const scannedByPort = new Map();
    for (const s of scanned) {
      scannedByPort.set(s.port, s);
    }

    const existing = getSessions(id);
    const result = [];
    const matchedPorts = new Set();

    // Reconcile registry entries with live processes
    for (const [sessionId, session] of existing) {
      if (scannedByPort.has(session.port)) {
        const live = scannedByPort.get(session.port);
        // Update PID in case it changed, keep label
        session.pid = live.pid;
        result.push({ id: sessionId, label: session.label, type: session.type || 'shell' });
        matchedPorts.add(session.port);
      } else {
        // Process no longer running — remove stale entry
        removeSession(id, sessionId);
      }
    }

    // Discover processes not in registry (orphaned after server restart)
    const discovered = scanned
      .filter(s => !matchedPorts.has(s.port))
      .sort((a, b) => a.port - b.port); // sort by port to approximate creation order

    for (const proc of discovered) {
      const sessionId = randomUUID().slice(0, 8);
      const label = proc.type === 'code'
        ? `Code ${proc.port - 7680}`
        : `Shell ${proc.port - 7680}`;

      addSession(id, sessionId, {
        port: proc.port,
        pid: proc.pid,
        label,
        type: proc.type,
        createdAt: Date.now(),
      });
      result.push({ id: sessionId, label, type: proc.type });
    }

    return { success: true, sessions: result };
  } catch {
    // Container likely gone, clear all
    clearWorkspaceSessions(id);
    return { success: true, sessions: [] };
  }
}

/**
 * Get diff stats for a workspace (insertions/deletions vs remote base branch).
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, insertions?: number, deletions?: number, message?: string}>}
 */
export async function getWorkspaceDiffStats(id, authenticatedUser) {
  const user = authenticatedUser || await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }

  try {
    const { workspaceDir } = await import('../tools/docker.js');
    const repoPath = `${workspaceDir(id)}/workspace`;

    const fs = await import('fs');
    if (!fs.existsSync(repoPath)) {
      return { success: false };
    }

    const { execSync } = await import('child_process');
    const opts = { cwd: repoPath, encoding: 'utf8', timeout: 5000 };

    const baseBranch = workspace.branch || 'main';
    let currentBranch;
    try {
      const detected = execSync(`git -c safe.directory='*' rev-parse --abbrev-ref HEAD`, opts).trim();
      currentBranch = (detected && detected !== 'HEAD') ? detected : null;
    } catch { /* leave null */ }
    let diffRef;
    if (currentBranch) {
      try {
        execSync(`git -c safe.directory='*' rev-parse --verify origin/${currentBranch} 2>/dev/null`, opts);
        diffRef = `origin/${currentBranch}`;
      } catch {
        diffRef = `origin/${baseBranch}`;
      }
    } else {
      diffRef = `origin/${baseBranch}`;
    }

    // Tracked changes (committed + staged + unstaged) vs origin
    const numstat = execSync(
      `git -c safe.directory='*' diff --numstat ${diffRef} 2>/dev/null`,
      opts
    );

    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.split('\n')) {
      if (!line) continue;
      const [add, del] = line.split('\t');
      if (add !== '-') insertions += parseInt(add, 10);
      if (del !== '-') deletions += parseInt(del, 10);
    }

    // Untracked files — count lines as insertions
    const untracked = execSync(
      `git -c safe.directory='*' ls-files --others --exclude-standard 2>/dev/null`,
      opts
    );
    for (const file of untracked.split('\n')) {
      if (!file) continue;
      try {
        const count = parseInt(execSync(`grep -c '' "${file}"`, opts).trim(), 10);
        insertions += count;
      } catch {
        insertions += 1;
      }
    }

    updateHasChanges(id, insertions > 0 || deletions > 0);

    // Keep the linked chat's updatedAt fresh so it doesn't fall behind in the sidebar
    if (insertions > 0 || deletions > 0) {
      const chat = getChatByWorkspaceId(id);
      if (chat) touchChatUpdatedAt(chat.id);
    }

    // Sync featureBranch in DB if the actual branch differs
    if (currentBranch && currentBranch !== workspace.featureBranch) {
      const { updateFeatureBranch } = await import('../db/code-workspaces.js');
      updateFeatureBranch(id, currentBranch);
    }

    return { success: true, insertions, deletions, currentBranch };
  } catch (err) {
    console.error(`[getWorkspaceDiffStats] workspace=${id}`, err);
    return { success: false };
  }
}

/**
 * Get full unified diff for a workspace (for diff viewer rendering).
 * Returns a unified diff string covering tracked and untracked changes vs origin.
 * @param {string} id - Workspace ID
 * @param {object} [authenticatedUser] - Pre-authenticated user (from route handler)
 * @returns {Promise<{success: boolean, diff?: string}>}
 */
export async function getWorkspaceDiffFull(id, authenticatedUser) {
  const user = authenticatedUser || await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }

  try {
    const { workspaceDir } = await import('../tools/docker.js');
    const repoPath = `${workspaceDir(id)}/workspace`;

    const fs = await import('fs');
    const path = await import('path');
    if (!fs.existsSync(repoPath)) {
      return { success: false };
    }

    const { execSync } = await import('child_process');
    const opts = { cwd: repoPath, encoding: 'utf8', timeout: 10000 };

    const baseBranch = workspace.branch || 'main';
    let currentBranch;
    try {
      const detected = execSync(`git -c safe.directory='*' rev-parse --abbrev-ref HEAD`, opts).trim();
      currentBranch = (detected && detected !== 'HEAD') ? detected : null;
    } catch { /* leave null */ }
    let diffRef;
    if (currentBranch) {
      try {
        execSync(`git -c safe.directory='*' rev-parse --verify origin/${currentBranch} 2>/dev/null`, opts);
        diffRef = `origin/${currentBranch}`;
      } catch {
        diffRef = `origin/${baseBranch}`;
      }
    } else {
      diffRef = `origin/${baseBranch}`;
    }

    // Tracked changes — full unified diff
    let diff = '';
    try {
      diff = execSync(
        `git -c safe.directory='*' diff ${diffRef} 2>/dev/null`,
        opts
      );
    } catch {}

    // Untracked files — synthesize unified diff from file contents
    let untrackedFiles = '';
    try {
      untrackedFiles = execSync(
        `git -c safe.directory='*' ls-files --others --exclude-standard 2>/dev/null`,
        opts
      );
    } catch {}

    for (const file of untrackedFiles.split('\n')) {
      if (!file) continue;
      try {
        const content = fs.readFileSync(path.join(repoPath, file), 'utf8');
        const lines = content.split('\n');
        // Remove trailing empty line from split if file ends with newline
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        diff += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`;
        for (const line of lines) {
          diff += `+${line}\n`;
        }
      } catch {}
    }

    return { success: true, diff };
  } catch (err) {
    console.error(`[getWorkspaceDiffFull] workspace=${id}`, err);
    return { success: false };
  }
}

/**
 * Launch a workspace command container and return immediately.
 * The client connects to /stream/containers/logs?name=...&cleanup=true for live output.
 * @param {string} id - Workspace ID
 * @param {string} command - 'commit' | 'push' | 'create-pr' | 'pull' | 'pull-push'
 * @returns {Promise<{success: boolean, containerName?: string, message?: string}>}
 */
export async function launchWorkspaceCommand(id, command) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, message: 'Workspace not found' };
  }

  try {
    const { workspaceDirExists, runCommandContainer } =
      await import('../tools/docker.js');

    if (!workspaceDirExists(id)) {
      return { success: false, message: 'Start coding first.' };
    }

    const { randomUUID } = await import('crypto');
    const shortId = id.replace(/-/g, '').slice(0, 8);
    const containerName = `command-${command}-${shortId}-${randomUUID().slice(0, 8)}`;

    const branch = workspace.branch || 'main';
    const featureBranch = workspace.featureBranch || '';
    const prompt = getCommandPrompt(command, { branch, featureBranch });

    await runCommandContainer({
      containerName,
      command,
      workspaceId: id,
      repo: workspace.repo,
      branch,
      featureBranch: workspace.featureBranch,
      prompt,
    });

    return { success: true, containerName };
  } catch (err) {
    console.error(`[launchWorkspaceCommand] workspace=${id} command=${command}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Run a workspace command (ephemeral container on existing workspace volume).
 * Waits for the container to finish and returns its output.
 * @deprecated Use launchWorkspaceCommand + SSE streaming instead.
 * @param {string} id - Workspace ID
 * @param {string} command - 'commit' | 'push' | 'create-pr' | 'pull' | 'pull-push'
 * @returns {Promise<{success: boolean, output?: string, exitCode?: number, message?: string}>}
 */
export async function runWorkspaceCommand(id, command) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, message: 'Workspace not found' };
  }

  try {
    const { workspaceDirExists, runCommandContainer, waitForContainer, getContainerLogs, removeContainer } =
      await import('../tools/docker.js');

    if (!workspaceDirExists(id)) {
      return { success: false, message: 'Start coding first.' };
    }

    const { randomUUID } = await import('crypto');
    const shortId = id.replace(/-/g, '').slice(0, 8);
    const containerName = `command-${command}-${shortId}-${randomUUID().slice(0, 8)}`;

    // Build prompt based on command type
    const branch = workspace.branch || 'main';
    const featureBranch = workspace.featureBranch || '';
    const prompt = getCommandPrompt(command, { branch, featureBranch });

    await runCommandContainer({
      containerName,
      command,
      workspaceId: id,
      repo: workspace.repo,
      branch,
      featureBranch: workspace.featureBranch,
      prompt,
    });

    // Wait for the container to finish, then collect output
    const exitCode = await waitForContainer(containerName);
    let output = '';
    try {
      output = await getContainerLogs(containerName);
    } catch {}

    // Clean up the stopped container
    try {
      await removeContainer(containerName);
    } catch {}

    return { success: exitCode === 0, output, exitCode };
  } catch (err) {
    console.error(`[runWorkspaceCommand] workspace=${id} command=${command}`, err);
    return { success: false, message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Port forwarding server actions
// ---------------------------------------------------------------------------

/**
 * Forward a port from a workspace container via Traefik.
 * @param {string} id - Workspace ID
 * @param {number} port - Port number to forward
 * @returns {Promise<{success: boolean, url?: string, message?: string}>}
 */
export async function forwardPort(id, port) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id || !workspace.containerName) {
    return { success: false, message: 'Workspace not found' };
  }

  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return { success: false, message: 'Invalid port number' };
  }

  addForward(id, portNum, {
    containerName: workspace.containerName,
    createdAt: Date.now(),
  });

  const shortId = id.slice(0, 8);
  const url = `http://${shortId}-${portNum}.localhost`;

  return { success: true, url };
}

/**
 * List active port forwards for a workspace.
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, ports?: Array<{port: number, url: string, createdAt: number}>}>}
 */
export async function listPortForwards(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, ports: [] };
  }

  const fwds = getForwards(id);
  const shortId = id.slice(0, 8);
  const ports = [];

  for (const [port, data] of fwds) {
    ports.push({
      port,
      url: `http://${shortId}-${port}.localhost`,
      createdAt: data.createdAt,
    });
  }

  return { success: true, ports };
}

/**
 * Remove a port forward for a workspace.
 * @param {string} id - Workspace ID
 * @param {number} port - Port number to remove
 * @returns {Promise<{success: boolean}>}
 */
export async function stopPortForward(id, port) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }

  removeForward(id, parseInt(port, 10));
  return { success: true };
}

// ---------------------------------------------------------------------------
// File operation server actions (used by the browser editor tab)
// ---------------------------------------------------------------------------

/**
 * Validate and resolve a path inside the workspace root. Rejects traversal.
 * @param {string} relativePath
 * @returns {string} Absolute path inside the container workspace
 */
function resolveWorkspacePath(relativePath) {
  // Normalize: strip leading slash so join is predictable
  const cleaned = (relativePath || '').replace(/^\/+/, '');
  const resolved = `${WORKSPACE_ROOT}/${cleaned}`;
  // Prevent traversal above workspace root
  if (!resolved.startsWith(WORKSPACE_ROOT + '/') && resolved !== WORKSPACE_ROOT) {
    throw new Error('Path outside workspace');
  }
  // Extra check: reject '..' components
  if (cleaned.split('/').includes('..')) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

/**
 * Get workspace with ownership check and running container.
 */
async function getRunningWorkspace(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id || !workspace.containerName) {
    return null;
  }
  return workspace;
}

/**
 * List directory contents inside the workspace container.
 * @param {string} id - Workspace ID
 * @param {string} dirPath - Relative path within workspace (e.g. '' or 'src/components')
 * @returns {Promise<{success: boolean, entries?: Array, message?: string}>}
 */
export async function listDirectory(id, dirPath = '') {
  const workspace = await getRunningWorkspace(id);
  if (!workspace) return { success: false, message: 'Workspace not found' };

  try {
    const absPath = resolveWorkspacePath(dirPath);
    const { execInContainer } = await import('../tools/docker.js');

    const raw = await execInContainer(
      workspace.containerName,
      `ls -la --time-style=+%s ${JSON.stringify(absPath)} 2>/dev/null`,
      10000,
    );

    if (raw === null) return { success: true, entries: [] };

    const entries = [];
    for (const line of raw.trim().split('\n')) {
      if (line.startsWith('total ')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 7) continue;

      const perms = parts[0];
      const size = parseInt(parts[4], 10);
      const modified = parseInt(parts[5], 10);
      const name = parts.slice(6).join(' ');

      if (name === '.' || name === '..') continue;

      const type = perms.startsWith('d') ? 'directory'
        : perms.startsWith('l') ? 'symlink'
        : 'file';

      entries.push({ name, type, size: isNaN(size) ? 0 : size, modified: isNaN(modified) ? 0 : modified });
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    return { success: true, entries };
  } catch (err) {
    console.error(`[listDirectory] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Read a file from the workspace container.
 * @param {string} id - Workspace ID
 * @param {string} filePath - Relative path within workspace
 * @returns {Promise<{success: boolean, content?: string, message?: string}>}
 */
export async function readFile(id, filePath) {
  const workspace = await getRunningWorkspace(id);
  if (!workspace) return { success: false, message: 'Workspace not found' };

  try {
    const absPath = resolveWorkspacePath(filePath);
    const { execInContainer } = await import('../tools/docker.js');

    // Check file size and mime type in a single exec call
    const infoOut = await execInContainer(
      workspace.containerName,
      `stat -c %s ${JSON.stringify(absPath)} 2>/dev/null; file --mime-type -b ${JSON.stringify(absPath)} 2>/dev/null`,
    );
    if (infoOut !== null) {
      const lines = infoOut.trim().split('\n');
      const fileSize = parseInt(lines[0], 10);
      if (!isNaN(fileSize) && fileSize > 2 * 1024 * 1024) {
        return { success: false, message: 'File too large (> 2MB)' };
      }
      const mime = (lines[1] || '').trim();
      const isText = mime.startsWith('text/') || mime === 'application/json' ||
        mime === 'application/javascript' || mime === 'application/xml' ||
        mime === 'application/x-empty' || mime === 'inode/x-empty';
      if (!isText && mime && mime !== '') {
        return { success: false, message: `Binary file (${mime})`, binary: true };
      }
    }

    const content = await execInContainer(
      workspace.containerName,
      `cat ${JSON.stringify(absPath)} 2>/dev/null`,
      30000,
    );

    return { success: true, content: content || '' };
  } catch (err) {
    console.error(`[readFile] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Write content to a file in the workspace container.
 * @param {string} id - Workspace ID
 * @param {string} filePath - Relative path within workspace
 * @param {string} content - File content
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function writeFile(id, filePath, content) {
  const workspace = await getRunningWorkspace(id);
  if (!workspace) return { success: false, message: 'Workspace not found' };

  try {
    const absPath = resolveWorkspacePath(filePath);
    const { execInContainer } = await import('../tools/docker.js');

    // Base64 encode to handle special chars and binary-safe transfer
    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    await execInContainer(
      workspace.containerName,
      `echo '${b64}' | base64 -d > ${JSON.stringify(absPath)}`,
      30000,
    );

    return { success: true };
  } catch (err) {
    console.error(`[writeFile] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Create a new file in the workspace container.
 * @param {string} id - Workspace ID
 * @param {string} filePath - Relative path within workspace
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function createFile(id, filePath) {
  const workspace = await getRunningWorkspace(id);
  if (!workspace) return { success: false, message: 'Workspace not found' };

  try {
    const absPath = resolveWorkspacePath(filePath);
    const { execInContainer } = await import('../tools/docker.js');
    await execInContainer(workspace.containerName, `touch ${JSON.stringify(absPath)}`);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Create a new directory in the workspace container.
 * @param {string} id - Workspace ID
 * @param {string} dirPath - Relative path within workspace
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function createDirectory(id, dirPath) {
  const workspace = await getRunningWorkspace(id);
  if (!workspace) return { success: false, message: 'Workspace not found' };

  try {
    const absPath = resolveWorkspacePath(dirPath);
    const { execInContainer } = await import('../tools/docker.js');
    await execInContainer(workspace.containerName, `mkdir -p ${JSON.stringify(absPath)}`);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Delete a file or directory in the workspace container.
 * @param {string} id - Workspace ID
 * @param {string} filePath - Relative path within workspace
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function deleteFile(id, filePath) {
  const workspace = await getRunningWorkspace(id);
  if (!workspace) return { success: false, message: 'Workspace not found' };

  try {
    const absPath = resolveWorkspacePath(filePath);
    // Never allow deleting the workspace root
    if (absPath === WORKSPACE_ROOT) {
      return { success: false, message: 'Cannot delete workspace root' };
    }
    const { execInContainer } = await import('../tools/docker.js');
    await execInContainer(workspace.containerName, `rm -rf ${JSON.stringify(absPath)}`);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Rename/move a file or directory in the workspace container.
 * @param {string} id - Workspace ID
 * @param {string} oldPath - Current relative path
 * @param {string} newPath - New relative path
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function renameFile(id, oldPath, newPath) {
  const workspace = await getRunningWorkspace(id);
  if (!workspace) return { success: false, message: 'Workspace not found' };

  try {
    const absOld = resolveWorkspacePath(oldPath);
    const absNew = resolveWorkspacePath(newPath);
    const { execInContainer } = await import('../tools/docker.js');
    await execInContainer(workspace.containerName, `mv ${JSON.stringify(absOld)} ${JSON.stringify(absNew)}`);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}
