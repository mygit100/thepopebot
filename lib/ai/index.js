import { randomUUID } from 'crypto';
import { z } from 'zod';
import path from 'path';
import { existsSync } from 'fs';
import { callHelperLlm, callHelperLlmStructured } from './helper-llm.js';
import { PROJECT_ROOT } from '../paths.js';
import { render_md } from '../utils/render-md.js';
import { buildCodingAgentSystemPrompt } from './system-prompt.js';
import { getChatById, createChat, updateChatTitle, linkChatToWorkspace, saveMessage } from '../db/chats.js';
import { getConfig } from '../config.js';
import { getSdkAdapter } from './sdk-adapters/index.js';
import { ensureWorkspaceRepo } from './workspace-setup.js';
import { resolveAgentScope } from './scope.js';
import { readSessionId, writeSessionId } from './session-manager.js';
import { workspaceDir as getWorkspaceDir } from '../tools/docker.js';
import { getCommandPrompt } from '../git-commands.js';

/**
 * Collect streamed text for channels that don't stream (e.g. Telegram one-shot).
 * Delegates to chatStream — single source of truth.
 */
async function chat(threadId, message, attachments = [], options = {}) {
  let fullText = '';
  for await (const chunk of chatStream(threadId, message, attachments, options)) {
    if (chunk.type === 'text') fullText += chunk.text;
  }
  return fullText;
}

/**
 * Process a chat message with streaming.
 * Saves user and assistant messages to the DB automatically.
 *
 * Two paths share identical chunk shape and persistence patterns:
 *   - SDK path: in-process @anthropic-ai/claude-agent-sdk (claude-code only)
 *   - Direct path: headless Docker container running the configured coding agent
 */
async function* chatStream(threadId, message, attachments = [], options = {}) {
  if (!options.userId) {
    throw new Error('chatStream requires options.userId');
  }
  const isCodeMode = !!options.codeMode;
  const existingChat = getChatById(threadId);
  let workspaceId = options.workspaceId;
  const repo = options.repo;
  const branch = options.branch;
  const codeModeType = options.codeModeType || 'plan';

  // Resolve workspace — for existing chats, read scope from DB (client may not resend it after refresh)
  let resolvedScope = options.scope || null;

  if (!existingChat) {
    if (!workspaceId) {
      // Resolve repo + branch on the server. Agent mode uses configured GH_OWNER/GH_REPO
      // and always detects the default branch. Code mode uses user-picked repo and falls
      // back to detection only if no branch was provided.
      let resolvedRepo = repo;
      if (!isCodeMode) {
        const ghOwner = getConfig('GH_OWNER');
        const ghRepo = getConfig('GH_REPO');
        if (ghOwner && ghRepo) resolvedRepo = `${ghOwner}/${ghRepo}`;
      }
      let resolvedBranch = branch;
      if (resolvedRepo && (!isCodeMode || !resolvedBranch)) {
        try {
          const { getDefaultBranch } = await import('../tools/github.js');
          const detected = await getDefaultBranch(resolvedRepo);
          if (detected) resolvedBranch = detected;
        } catch {}
      }

      const { createCodeWorkspace, updateFeatureBranch } = await import('../db/code-workspaces.js');
      const workspace = createCodeWorkspace(options.userId, {
        repo: resolvedRepo,
        branch: resolvedBranch,
        scope: resolvedScope,
      });
      workspaceId = workspace.id;
      const branchMode = getConfig(isCodeMode ? 'CODE_MODE_BRANCH' : 'AGENT_MODE_BRANCH');
      if (branchMode === 'dynamic') {
        const { generateRandomName } = await import('../utils/random-name.js');
        const shortId = workspaceId.replace(/-/g, '').slice(0, 8);
        const featureBranch = `thepopebot/${generateRandomName()}-${shortId}`;
        updateFeatureBranch(workspaceId, featureBranch);
      } else {
        // Default branch mode — featureBranch mirrors the working branch so
        // downstream prompts never see an empty value.
        if (resolvedBranch) updateFeatureBranch(workspaceId, resolvedBranch);
      }
    }
    createChat(options.userId, 'New Chat', threadId, { chatMode: isCodeMode ? 'code' : 'agent' });
    linkChatToWorkspace(threadId, workspaceId);
  } else {
    workspaceId = workspaceId || existingChat.codeWorkspaceId;
    if (!resolvedScope && workspaceId) {
      const { getCodeWorkspaceById } = await import('../db/code-workspaces.js');
      const ws = getCodeWorkspaceById(workspaceId);
      if (ws?.scope) resolvedScope = ws.scope;
    }
  }

  // Save user message (skip on regeneration — message already exists)
  if (!options.skipUserPersist) {
    try { saveMessage(threadId, options.userId,'user', message || '[attachment]'); } catch {}
  }

  const wsBaseDir = getWorkspaceDir(workspaceId);
  const repoDir = path.join(wsBaseDir, 'workspace');
  const codingAgent = getConfig('CODING_AGENT') || 'opencode';
  const sdkAdapter = getSdkAdapter(codingAgent);

  // Read the resolved repo + branch from the workspace record (set at creation time).
  const { getCodeWorkspaceById } = await import('../db/code-workspaces.js');
  const workspace = getCodeWorkspaceById(workspaceId);
  const featureBranch = workspace?.featureBranch;

  // Resolve agent-mode-specific vs code-mode-specific values used by both paths
  let effectiveRepo, effectiveBranch, systemPrompt, injectSecrets;
  if (isCodeMode) {
    effectiveRepo = workspace?.repo || repo;
    effectiveBranch = workspace?.branch || branch;
    systemPrompt = buildCodingAgentSystemPrompt('code');
    injectSecrets = false;
  } else {
    const ghOwner = getConfig('GH_OWNER');
    const ghRepo = getConfig('GH_REPO');
    if (!ghOwner || !ghRepo) {
      const msg = 'GH_OWNER or GH_REPO not configured';
      yield { type: 'error', message: msg };
      try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({ type: 'error', message: msg })); } catch {}
      return;
    }
    effectiveRepo = `${ghOwner}/${ghRepo}`;
    effectiveBranch = workspace?.branch || null;
    const { skillsDir } = resolveAgentScope(repoDir, resolvedScope || null);
    systemPrompt = buildCodingAgentSystemPrompt('agent', skillsDir, resolvedScope || null);
    injectSecrets = true;
  }

  // Workspace setup — visible to user as a `workspace` tool-call the first time
  const needsSetup = !existsSync(path.join(repoDir, '.git'));
  const setupToolCallId = `setup-${workspaceId.slice(0, 8)}`;
  const setupArgs = { repo: effectiveRepo, branch: effectiveBranch, featureBranch };

  if (needsSetup) {
    yield { type: 'tool-call', toolCallId: setupToolCallId, toolName: 'workspace', args: setupArgs };
  }

  try {
    const setupOutput = await ensureWorkspaceRepo({ workspaceDir: repoDir, repo: effectiveRepo, branch: effectiveBranch, featureBranch });
    if (needsSetup) {
      const result = setupOutput || `Workspace ready on ${featureBranch || effectiveBranch}`;
      yield { type: 'tool-result', toolCallId: setupToolCallId, result };
      try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({
        type: 'tool-invocation',
        toolCallId: setupToolCallId,
        toolName: 'workspace',
        state: 'output-available',
        input: setupArgs,
        output: result,
      })); } catch {}
    }
  } catch (err) {
    const msg = err.message || 'Workspace setup failed';
    if (needsSetup) {
      yield { type: 'tool-result', toolCallId: setupToolCallId, result: `Setup failed: ${msg}` };
    }
    yield { type: 'error', message: msg };
    try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({ type: 'error', message: msg })); } catch {}
    return;
  }

  // Fork on SDK availability — track whether the inner stream errored so we can
  // skip auto-run on failure.
  let innerErrored = false;
  const inner = sdkAdapter
    ? streamViaSdk({ threadId, message, attachments, options, wsBaseDir, repoDir, resolvedScope, isCodeMode, codeModeType, systemPrompt, workspaceId, sdkAdapter })
    : streamViaContainer({ threadId, message, options, codingAgent, workspaceId, featureBranch, effectiveRepo, effectiveBranch, systemPrompt, injectSecrets, codeModeType, resolvedScope });
  for await (const chunk of inner) {
    if (chunk.type === 'error') innerErrored = true;
    yield chunk;
  }

  // Auto-run the configured git action when enabled, the stream succeeded,
  // and the workspace has uncommitted changes. Fire-and-forget — emits a
  // single chunk the API layer surfaces to the web client.
  if (!innerErrored) {
    try {
      const autoRunChunk = await maybeAutoRun({ workspaceId, isCodeMode, repoDir });
      if (autoRunChunk) yield autoRunChunk;
    } catch (err) {
      console.error('[chatStream] auto-run failed:', err.message);
    }
  }

  // Auto-generate title for new chats (runs once after either path completes)
  if (options.userId && message) {
    autoTitle(threadId, message).catch(() => {});
  }
}

/**
 * If the mode's auto-run flag is on and the workspace has local changes,
 * launch a workspace command container with the configured git action.
 * Returns an `auto-run` chunk on launch, or null when skipped.
 */
async function maybeAutoRun({ workspaceId, isCodeMode, repoDir }) {
  const flagKey = isCodeMode ? 'CODE_MODE_AUTO_RUN' : 'AGENT_MODE_AUTO_RUN';
  if (getConfig(flagKey) !== 'true') return null;

  // Skip when there are no local changes — nothing to commit/push/PR.
  const { execSync } = await import('child_process');
  let dirty = '';
  try {
    dirty = execSync(`git -c safe.directory='*' status --porcelain`, {
      cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
  if (!dirty) return null;

  const command = getConfig(isCodeMode ? 'CODE_MODE_GIT_ACTION' : 'AGENT_MODE_GIT_ACTION') || 'push';

  const { getCodeWorkspaceById } = await import('../db/code-workspaces.js');
  const workspace = getCodeWorkspaceById(workspaceId);
  if (!workspace) return null;

  const branch = workspace.branch || 'main';
  const featureBranch = workspace.featureBranch || '';
  const prompt = getCommandPrompt(command, { branch, featureBranch });

  // Random suffix prevents collisions with manual runs and other auto-runs.
  const shortId = workspaceId.replace(/-/g, '').slice(0, 8);
  const containerName = `command-auto-${command}-${shortId}-${randomUUID().slice(0, 6)}`;

  const { runCommandContainer } = await import('../tools/docker.js');
  await runCommandContainer({
    containerName,
    command,
    workspaceId,
    repo: workspace.repo,
    branch,
    featureBranch: workspace.featureBranch,
    prompt,
  });

  return { type: 'auto-run', containerName, command };
}

/**
 * SDK path — in-process @anthropic-ai/claude-agent-sdk.
 * Used only when a registered SDK adapter exists for the active coding agent.
 */
async function* streamViaSdk({ threadId, message, attachments, options, wsBaseDir, repoDir, resolvedScope, isCodeMode, codeModeType, systemPrompt, workspaceId, sdkAdapter }) {
  const chatMode = isCodeMode ? 'code' : 'agent';
  const { workingDir } = resolveAgentScope(repoDir, resolvedScope);
  const sessionId = readSessionId(wsBaseDir);

  let pendingText = '';
  const pendingToolCalls = new Map();

  try {
    for await (const chunk of sdkAdapter({
      prompt: message,
      workspaceDir: workingDir,
      systemPrompt,
      sessionId,
      permissionMode: codeModeType,
      attachments,
      workspaceId,
      chatMode,
      userId: options.userId,
    })) {
      if (chunk.type === 'meta' && chunk.sessionId) {
        writeSessionId(wsBaseDir, chunk.sessionId);
      }

      if (chunk.type === 'text') {
        pendingText += chunk.text;
      } else if (chunk.type === 'tool-call') {
        if (pendingText) {
          try { saveMessage(threadId, options.userId,'assistant', pendingText); } catch {}
          pendingText = '';
        }
        pendingToolCalls.set(chunk.toolCallId, { toolName: chunk.toolName, args: chunk.args });
      } else if (chunk.type === 'tool-result') {
        const tc = pendingToolCalls.get(chunk.toolCallId);
        if (tc) {
          try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({
            type: 'tool-invocation',
            toolCallId: chunk.toolCallId,
            toolName: tc.toolName,
            state: 'output-available',
            input: tc.args,
            output: chunk.result,
          })); } catch {}
          pendingToolCalls.delete(chunk.toolCallId);
        }
      }

      yield chunk;
    }
  } catch (err) {
    const msg = err.message || 'SDK stream failed';
    console.error('[streamViaSdk] error:', err);
    yield { type: 'error', message: msg };
    try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({ type: 'error', message: msg })); } catch {}
  } finally {
    if (pendingText) {
      try { saveMessage(threadId, options.userId,'assistant', pendingText); } catch {}
    }
  }
}

/**
 * Direct headless path — spawn the coding agent in an ephemeral Docker container,
 * stream its output via parseHeadlessStream, and yield normalized chunks.
 *
 * Replaces the former LangGraph React agent + `coding_agent` tool — there is no
 * LLM layer between the user's message and the container. Multi-turn memory
 * lives in the agent's own session files inside the volume-mounted workspace
 * (see docker/coding-agent/CLAUDE.md § Session Tracking).
 */
async function* streamViaContainer({ threadId, message, options, codingAgent, workspaceId, featureBranch, effectiveRepo, effectiveBranch, systemPrompt, injectSecrets, codeModeType, resolvedScope }) {
  const containerName = `${codingAgent}-headless-${randomUUID().slice(0, 8)}`;
  const mode = codeModeType === 'code' ? 'dangerous' : 'plan';
  const { runHeadlessContainer, tailContainerLogs, waitForContainer, removeContainer } = await import('../tools/docker.js');
  const { parseHeadlessStream } = await import('./headless-stream.js');

  // Synthetic coding_agent wrapper — bracketing tool-call/tool-result pair so the
  // user can see that the direct-container path ran (the SDK path has no wrapper).
  // Inner container chunks stream as top-level parts alongside it; AI SDK parts
  // are flat, so this is a visual anchor, not a container for nested content.
  const wrapperId = `coding-agent-${randomUUID().slice(0, 8)}`;
  const providerKeys = {
    'claude-code': 'CODING_AGENT_CLAUDE_CODE_BACKEND',
    'pi-coding-agent': 'CODING_AGENT_PI_PROVIDER',
    'gemini-cli': 'CODING_AGENT_GEMINI_CLI_PROVIDER',
    'codex-cli': 'CODING_AGENT_CODEX_CLI_PROVIDER',
    'opencode': 'CODING_AGENT_OPENCODE_PROVIDER',
    'kimi-cli': 'CODING_AGENT_KIMI_CLI_PROVIDER',
  };
  const backendApi = getConfig(providerKeys[codingAgent]) || 'anthropic';
  const wrapperArgs = { prompt: message, codingAgent, backendApi };

  yield { type: 'tool-call', toolCallId: wrapperId, toolName: 'coding_agent', args: wrapperArgs };

  let pendingText = '';
  const pendingToolCalls = new Map();
  let started = false;
  let wrapperClosed = false;
  let producedAny = false;
  let stderrTail = '';
  const STDERR_TAIL_MAX = 4096;

  const closeWrapper = (result) => {
    if (wrapperClosed) return null;
    wrapperClosed = true;
    try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({
      type: 'tool-invocation',
      toolCallId: wrapperId,
      toolName: 'coding_agent',
      state: 'output-available',
      input: wrapperArgs,
      output: result,
    })); } catch {}
    return { type: 'tool-result', toolCallId: wrapperId, result };
  };

  try {
    await runHeadlessContainer({
      containerName,
      repo: effectiveRepo,
      branch: effectiveBranch,
      featureBranch,
      workspaceId,
      taskPrompt: message,
      mode,
      systemPrompt,
      injectSecrets,
      scope: resolvedScope || undefined,
      userId: options.userId,
    });
    started = true;

    const logStream = await tailContainerLogs(containerName);

    for await (const chunk of parseHeadlessStream(logStream, codingAgent)) {
      // Buffer stderr server-side; never yield to the caller. Surfaced only
      // when the agent died silently (producedAny stays false at stream end).
      if (chunk.type === 'stderr') {
        stderrTail = (stderrTail + chunk.text).slice(-STDERR_TAIL_MAX);
        continue;
      }
      if (chunk.type === 'text' || chunk.type === 'tool-call' || chunk.type === 'tool-result') {
        producedAny = true;
      }
      if (chunk.type === 'text') {
        pendingText += chunk.text;
      } else if (chunk.type === 'tool-call') {
        if (pendingText) {
          try { saveMessage(threadId, options.userId,'assistant', pendingText); } catch {}
          pendingText = '';
        }
        pendingToolCalls.set(chunk.toolCallId, { toolName: chunk.toolName, args: chunk.args });
      } else if (chunk.type === 'tool-result') {
        const tc = pendingToolCalls.get(chunk.toolCallId);
        if (tc) {
          try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({
            type: 'tool-invocation',
            toolCallId: chunk.toolCallId,
            toolName: tc.toolName,
            state: 'output-available',
            input: tc.args,
            output: chunk.result,
          })); } catch {}
          pendingToolCalls.delete(chunk.toolCallId);
        }
      }

      yield chunk;
    }

    const exitCode = await waitForContainer(containerName);
    await removeContainer(containerName);

    const stderrTrimmed = stderrTail.trim();
    const silentFailure = !producedAny && stderrTrimmed;

    const closeResult = silentFailure
      ? `Error: ${stderrTrimmed}`
      : exitCode === 0 ? 'Completed' : `Exited with code ${exitCode}`;
    const closeChunk = closeWrapper(closeResult);
    if (closeChunk) yield closeChunk;

    if (silentFailure) {
      const msg = `Coding agent produced no output. Stderr:\n${stderrTrimmed}`;
      yield { type: 'error', message: msg };
      try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({ type: 'error', message: msg })); } catch {}
    } else if (exitCode !== 0) {
      const msg = `Coding agent exited with code ${exitCode}`;
      yield { type: 'error', message: msg };
      try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({ type: 'error', message: msg })); } catch {}
    }
  } catch (err) {
    const msg = err.message || 'Coding agent failed';
    console.error('[streamViaContainer] error:', err);
    const closeChunk = closeWrapper(`Error: ${msg}`);
    if (closeChunk) yield closeChunk;
    yield { type: 'error', message: msg };
    try { saveMessage(threadId, options.userId,'assistant', JSON.stringify({ type: 'error', message: msg })); } catch {}
    if (started) {
      try { await removeContainer(containerName); } catch {}
    }
  } finally {
    if (pendingText) {
      try { saveMessage(threadId, options.userId,'assistant', pendingText); } catch {}
    }
  }
}

/**
 * Auto-generate a chat title from the first user message (fire-and-forget).
 * Uses structured output to avoid thinking-token leaks with extended-thinking models.
 */
async function autoTitle(threadId, firstMessage) {
  try {
    const chat = getChatById(threadId);
    if (!chat || chat.title !== 'New Chat') return;

    const result = await callHelperLlmStructured({
      system: 'Title this chat in 2-5 words. Name the subject matter only. Never start with "User". Never describe what the user is doing — just the topic. Always produce a title, even for vague messages — infer the likely topic.',
      user: firstMessage,
      schema: z.object({ title: z.string() }),
      maxTokens: 250,
    });
    const title = result?.title?.trim();
    if (title) {
      updateChatTitle(threadId, title);
      return title;
    }
  } catch (err) {
    console.error('[autoTitle] Failed to generate title:', err.message);
  }
  return null;
}

/**
 * One-shot summarization with a different system prompt and no memory.
 * Used for agent job completion summaries sent via GitHub webhook.
 */
async function summarizeAgentJob(results) {
  try {
    const summaryMdPath = path.join(PROJECT_ROOT, 'event-handler/SUMMARY.md');
    const systemPrompt = render_md(summaryMdPath);

    if (!systemPrompt) {
      console.error(`[summarizeAgentJob] Empty system prompt — event-handler/SUMMARY.md not found or empty at: ${summaryMdPath}`);
    }

    const userMessage = [
      results.job ? `## Task\n${results.job}` : '',
      results.commit_message ? `## Commit Message\n${results.commit_message}` : '',
      results.changed_files?.length ? `## Changed Files\n${results.changed_files.join('\n')}` : '',
      results.status ? `## Status\n${results.status}` : '',
      results.merge_result ? `## Merge Result\n${results.merge_result}` : '',
      results.pr_url ? `## PR URL\n${results.pr_url}` : '',
      results.run_url ? `## Run URL\n${results.run_url}` : '',
      results.log ? `## Agent Log\n${results.log}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    console.log(`[summarizeAgentJob] System prompt: ${systemPrompt.length} chars, user message: ${userMessage.length} chars`);

    const text = await callHelperLlm({ system: systemPrompt, user: userMessage, maxTokens: 1024 });

    console.log(`[summarizeAgentJob] Result: ${text.length} chars — ${text.slice(0, 200)}`);

    return text || 'Agent job finished.';
  } catch (err) {
    console.error('[summarizeAgentJob] Failed to summarize agent job:', err);
    return 'Agent job finished.';
  }
}

export { chat, chatStream, summarizeAgentJob, autoTitle };
