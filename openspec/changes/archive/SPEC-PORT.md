# Spec: Port 指令整合到 Slack Agent

## 概要

在 slack-agent 加入 `port` 指令，讓 PM bot 可以從 Slack 觸發 port 分析流程。port = Explore original project + 現有 prd 流程 + Linear 回寫。

同時重構 `runPMPhase` 為共用的 `runAnalysis`，讓 `prd` 和 `port` 共用 PM + Designer + `/opsx:ff` 邏輯。

---

## 新增 Slack 指令

| 指令 | Bot | 說明 |
|------|-----|------|
| `@PM port CAF-XXX` | PM | Explore original project → PM + Designer → `/opsx:ff` → post Linear + Slack |
| `@PM portff CAF-XXX` | PM | port 全自動：port → hand off to Dev → PR |
| `@PM portff CAF-XXX: <instructions>` | PM | portff + 額外 Dev 指示 |

Dev bot **不需改動** — port 和 prd 產出相同的 OpenSpec artifacts，Dev bot 看到的 worktree 結構一模一樣。

---

## 架構改動

### 1. 重構 `runPMPhase` → `runAnalysis`

現有的 `runPMPhase`（agent.js L229-339）負責：
- pm-agent + designer-agent（parallel, cached）
- orchestrator `/opsx:ff`

重構為 `runAnalysis`，接受可選的 `sourceAnalysis` 參數：

```javascript
/**
 * 共用分析流程：PM + Designer agents → /opsx:ff
 * @param {string} ticketId
 * @param {string} worktreePath
 * @param {string} channelId
 * @param {string} threadTs
 * @param {object} opts
 * @param {string} [opts.sourceAnalysis] - Explore agent 的輸出（port 時提供）
 */
async function runAnalysis(ticketId, worktreePath, channelId, threadTs, opts = {}) {
  const { sourceAnalysis = null } = opts;
  // ... 以下邏輯
}
```

#### 1a. PM agent prompt 注入 source analysis

在 `runAndValidate` 呼叫 pm-agent 時，如果 `sourceAnalysis` 非空，將其注入 prompt：

```javascript
// 現有 (L243-247)
const input = `${ticketContext}\n\nSave output to: \`${cachePath}\``;

// 改為
let pmInput = `${ticketContext}\n\nSave output to: \`${cachePath}\``;
if (sourceAnalysis) {
  pmInput = `${ticketContext}\n\n## Source Analysis (from original project)\n\n${sourceAnalysis}\n\nUse this source analysis as additional context. This is a PORT — adapt requirements from the original project, do not assume 1:1 parity.\n\nIMPORTANT: Do NOT include source code from the original project (except data model definitions). Only describe requirements and approach.\n\nSave output to: \`${cachePath}\``;
}
```

#### 1b. Designer agent — 條件式觸發

port 時 designer 應依條件判斷是否啟動（prd 時維持現有行為：always run）。

```javascript
function detectNeedsDesign(ticket, sourceAnalysis) {
  if (ticket.description && /figma\.com/i.test(ticket.description)) return true;
  if (ticket.labels?.some(l => /design|ui|ux|frontend|visual/i.test(l))) return true;
  const uiKeywords = /screen|page|dialog|ui|layout|widget|modal|bottom.?sheet|navigation|tab|drawer/i;
  if (uiKeywords.test(ticket.title) || uiKeywords.test(ticket.description || "")) return true;
  if (sourceAnalysis) {
    const uiSection = sourceAnalysis.match(/## UI & Layout\n([\s\S]*?)(?=\n## |$)/);
    if (uiSection && uiSection[1].split("\n").filter(l => l.trim()).length > 3) return true;
  }
  return false;
}
```

在 `runAnalysis` 中：

```javascript
const agents = [
  { name: "pm-agent", cache: prdCache, suffix: "pm", label: "PRD" },
];

// prd: always run designer; port: conditional
if (!sourceAnalysis || detectNeedsDesign(ticket, sourceAnalysis)) {
  agents.push({ name: "designer-agent", cache: designCache, suffix: "designer", label: "Design" });
}
```

#### 1c. Orchestrator prompt 注入 source analysis

orchestrator `/opsx:ff` 的 prompt（L307-332）也需注入：

```javascript
let orchestratorPrompt = `${ticketContext}

## PRD (from PM agent)

${prdContent}
`;

if (designContent) {
  orchestratorPrompt += `
## Design Guidance (from Designer agent)

${designContent}
`;
}

if (sourceAnalysis) {
  orchestratorPrompt += `
## Source Analysis (from original project)

This is a PORT from an existing project. The source analysis below describes the original feature.
Do NOT copy source code. Use it as context for understanding requirements and data models.

${sourceAnalysis}
`;
}

orchestratorPrompt += `
## Your task

Run \`/opsx:ff ${titleSlug}\` — incorporate the PRD${designContent ? " and design guidance" : ""} above as context.
...
`;
```

#### 1d. 原有 `runPMPhase` 呼叫點

所有呼叫 `runPMPhase` 的地方改為呼叫 `runAnalysis`：

| 位置 | 現有呼叫 | 改為 |
|------|----------|------|
| prd handler (L535) | `await runPMPhase(ticketId, ...)` | `await runAnalysis(ticketId, ..., {})` |
| ff handler (L601) | `await runPMPhase(ticketId, ...)` | `await runAnalysis(ticketId, ..., {})` |
| dev handler (L845) | `await runPMPhase(ticketId, ...)` | `await runAnalysis(ticketId, ..., {})` |

行為完全不變（`sourceAnalysis` 預設為 null）。

---

### 2. 新增 `runExplore` 函式

掃描 original project，產出 source analysis。

```javascript
const ORIGINAL_PROJECT_PATH = process.env.ORIGINAL_PROJECT_PATH;

/**
 * 用 Claude CLI 掃描 original project
 * @param {string} ticketId
 * @param {string} worktreePath - 工作目錄（Claude 執行環境）
 * @returns {string} source analysis 內容
 */
async function runExplore(ticketId, worktreePath) {
  const ticketPath = `/tmp/ticket-${ticketId}.json`;
  const ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8"));

  const explorePrompt = `You are scanning an original project to document a feature for porting.

Original project path: ${ORIGINAL_PROJECT_PATH}
Feature: ${ticket.title}

Ticket context:
${ticket.description || "(no description)"}

Explore the codebase thoroughly and produce a structured markdown report:

## Feature Overview
Brief summary from user perspective.

## Files & Structure
Relevant files grouped by: screens, widgets, business logic, data models, state management, services.

## UI & Layout
Screens, navigation flow, UI state, user interactions.

## Data Models
Data classes, types, enums. Include field names and types.

## State Management
How state is managed. Key state classes and transitions.

## Business Logic & Rules
Core rules, validations, edge cases.

## API / Service Contracts
API calls, endpoints, service interfaces.

IMPORTANT:
- Do NOT include raw source code (except data model definitions).
- Focus on WHAT the feature does, not implementation internals.
- Data model definitions ARE allowed.`;

  const output = await runAsync(
    CLAUDE_BIN,
    ["--print", "--dangerously-skip-permissions", "--name", `${ticketId}-explore`],
    {
      input: explorePrompt,
      cwd: worktreePath,
      env: { ...process.env, GIT_WORK_TREE: worktreePath },
      timeout: CLAUDE_TIMEOUT_MS,
      ticketId: `${ticketId}:explore`,
    }
  );

  const cleaned = cleanAgentOutput(output);
  if (!cleaned || cleaned.length < 50) {
    throw new Error("Explore agent produced insufficient output");
  }

  // Cache to file for retry resilience
  const cachePath = path.join(worktreePath, "openspec", "changes");
  fs.mkdirSync(cachePath, { recursive: true });
  const cacheFile = path.join(cachePath, "port-source-analysis.md");
  fs.writeFileSync(cacheFile, cleaned, "utf8");

  return cleaned;
}
```

---

### 3. 新增 `upsertPortComment` 函式

Linear comment 採 upsert 模式：首次 create，後續 update（revise 時）同一則 comment。
`commentId` 存在 worktree 的 `port-linear-comment-id.txt`，讓 `port` 和 `update` 之間傳遞。

```javascript
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const COMMENT_ID_FILE = "port-linear-comment-id.txt";

async function getLinearIssueUuid(ticketId) {
  const query = `
    query { issueSearch(filter: { identifier: { eq: "${ticketId}" } }) { nodes { id } } }
  `;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: LINEAR_API_KEY },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  return data?.data?.issueSearch?.nodes?.[0]?.id || null;
}

function composePortCommentBody(ticketId, artifacts, revisionNote = null) {
  let body = `## Port Source Analysis\n\n${artifacts.sourceAnalysis}\n\n---\n\n`;
  body += `## Port PRD\n\n${artifacts.prd}\n\n`;
  if (artifacts.design) {
    body += `---\n\n## Port Design Changed\n\n${artifacts.design}\n\n`;
  }
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  if (revisionNote) {
    body += `---\n\n_Updated: ${now} — ${revisionNote}_`;
  } else {
    body += `---\n\n_Posted: ${now} by Slack PM Agent via \`@PM port ${ticketId}\`_`;
  }
  return body;
}

/**
 * Create or update the port artifacts comment on a Linear ticket.
 * First call: commentCreate → save commentId to worktree file.
 * Subsequent calls: commentUpdate using saved commentId.
 */
async function upsertPortComment(ticketId, worktreePath, artifacts, revisionNote = null) {
  const commentIdPath = path.join(worktreePath, COMMENT_ID_FILE);
  const existingCommentId = fs.existsSync(commentIdPath)
    ? fs.readFileSync(commentIdPath, "utf8").trim()
    : null;

  const body = composePortCommentBody(ticketId, artifacts, revisionNote);

  if (existingCommentId) {
    // Edit existing comment — no duplicate
    const mutation = `
      mutation { commentUpdate(id: "${existingCommentId}", input: { body: ${JSON.stringify(body)} }) { success } }
    `;
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: LINEAR_API_KEY },
      body: JSON.stringify({ query: mutation }),
    });
    const data = await res.json();
    if (data?.data?.commentUpdate?.success) {
      console.log(`[${ticketId}] Port comment updated on Linear`);
    } else {
      console.error(`[${ticketId}] Failed to update Linear comment:`, JSON.stringify(data));
    }
  } else {
    // Create new comment, save commentId
    const issueUuid = await getLinearIssueUuid(ticketId);
    if (!issueUuid) {
      console.error(`[${ticketId}] Could not find Linear issue UUID`);
      return;
    }
    const mutation = `
      mutation { commentCreate(input: { issueId: "${issueUuid}", body: ${JSON.stringify(body)} }) { success comment { id } } }
    `;
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: LINEAR_API_KEY },
      body: JSON.stringify({ query: mutation }),
    });
    const data = await res.json();
    if (data?.data?.commentCreate?.success) {
      const commentId = data.data.commentCreate.comment.id;
      fs.writeFileSync(commentIdPath, commentId, "utf8");
      console.log(`[${ticketId}] Port comment created on Linear (id: ${commentId})`);
    } else {
      console.error(`[${ticketId}] Failed to create Linear comment:`, JSON.stringify(data));
    }
  }
}
```

---

### 4. 新增 PM bot 指令 handler

#### 4a. Regex（加在 L505-508 附近）

```javascript
const portMatch = text.match(/^port\s+([A-Z]+-\d+)$/i);
const portffMatch = text.match(/^portff\s+([A-Z]+-\d+)(?:\s*:\s*([\s\S]+))?$/i);
```

#### 4b. Port handler（概要）

```
} else if (portMatch) {
  validate ORIGINAL_PROJECT_PATH exists
  → fetch ticket
  → ensureWorktreeInteractive
  → check existing artifacts (skip if exist)
  → runExplore(ticketId, worktreePath)
  → safetyCommit
  → runAnalysis(ticketId, worktreePath, ..., { sourceAnalysis })
  → commit + push
  → postArtifactsToSlack
  → upsertPortComment(ticketId, worktreePath, artifacts)
  → inform user: "Port analysis complete. Artifacts posted to Linear + Slack."
}
```

#### 4c. Portff handler（概要）

```
} else if (portffMatch) {
  same as port handler above
  → then: ffTickets.add(ticketId) + hand off to Dev via @Dev mention
}
```

---

### 5. Update handler 整合 — revise 時 upsert Linear

現有 `update` handler（L637-707）commit+push 後，加入 Linear upsert：

```javascript
// 在 update handler 的 commit+push 後面加：
const saPath = path.join(workDir, "openspec", "changes", "port-source-analysis.md");
if (fs.existsSync(saPath)) {
  // This is a port ticket — upsert the Linear comment
  const changesDir = path.join(workDir, "openspec", "changes");
  const dirs = fs.readdirSync(changesDir)
    .filter(d => d !== "archive" && d !== ".gitkeep" && fs.statSync(path.join(changesDir, d)).isDirectory());

  for (const dir of dirs) {
    const prdPath = path.join(changesDir, dir, "prd.md");
    const designPath = path.join(changesDir, dir, "design-guidance.md");

    // Extract last feedback line as revision note
    const lastFeedback = fullThread.split("\n\n").pop().slice(0, 100);

    await upsertPortComment(ticketId, workDir, {
      sourceAnalysis: fs.readFileSync(saPath, "utf8").trim(),
      prd: fs.existsSync(prdPath) ? fs.readFileSync(prdPath, "utf8").trim() : null,
      design: fs.existsSync(designPath) ? fs.readFileSync(designPath, "utf8").trim() : null,
    }, lastFeedback);
  }
  await postThread(client, channelId, threadTs, "Updated artifacts also synced to Linear.");
}
```

偵測方式：worktree 中有 `port-source-analysis.md` → 這是 port ticket → upsert。
prd ticket 的 worktree 不會有這個檔案，所以不受影響。

---

### 6. `.env` 新增設定

```bash
# Port: path to original project for source analysis (required for @PM port)
ORIGINAL_PROJECT_PATH=
```

在 `agent.js` 頂部加入（不 throw，只有 port 需要）：

```javascript
const ORIGINAL_PROJECT_PATH = process.env.ORIGINAL_PROJECT_PATH || "";
```

---

### 7. `CLAUDE.md` 更新

Slack Commands 表格加入：

```markdown
| `@PM port TICKET-ID` | PM | Explore original project → PRD + OpenSpec → post Linear |
| `@PM portff TICKET-ID` | PM | Port full auto: explore → artifacts → Dev → PR |
| `@PM portff TICKET-ID: <instructions>` | PM | Portff with extra Dev instructions |
```

---

## 流程比較

```
prd CAF-XXX:
  fetch ticket
  → ensureWorktree
  → runAnalysis(ticketId, wt)
  → commit + push
  → post Slack

port CAF-XXX:
  fetch ticket
  → ensureWorktree
  → runExplore(ticketId, wt)            ← 多的步驟
  → runAnalysis(ticketId, wt, { sa })
  → commit + push
  → upsertPortComment(...)              ← 多的步驟
  → post Slack

update (in port thread):
  revise artifacts
  → commit + push
  → upsertPortComment(... revisionNote) ← 自動 sync Linear

ff / portff:
  prd/port flow → hand off to Dev → auto-approve → implement → PR

dev CAF-XXX:
  不變
```

---

## 改動清單

| 檔案 | 改動類型 | 說明 |
|------|----------|------|
| `agent.js` | 重構 | `runPMPhase` → `runAnalysis`（加 `sourceAnalysis` 參數） |
| `agent.js` | 新增 | `runExplore()` 函式 |
| `agent.js` | 新增 | `upsertPortComment()` + `getLinearIssueUuid()` + `composePortCommentBody()` |
| `agent.js` | 新增 | `detectNeedsDesign()` 函式 |
| `agent.js` | 新增 | `port` regex + handler |
| `agent.js` | 新增 | `portff` regex + handler |
| `agent.js` | 新增 | `ORIGINAL_PROJECT_PATH` 常數 |
| `agent.js` | 修改 | `update` handler — port ticket 時 upsert Linear |
| `.env.example` | 新增 | `ORIGINAL_PROJECT_PATH` 欄位 |
| `CLAUDE.md` | 更新 | 加入 port/portff 指令文件 |

**不動的檔案：**
- `build_prompt.py` — port 不需新 prompt step
- `fetch_ticket.py` — 不變
- `linear_update.py` — 不變
- Dev bot handler — 不變

---

## 實作順序建議

1. **重構 `runPMPhase` → `runAnalysis`** — 加 `opts.sourceAnalysis`，所有呼叫點改為 `runAnalysis(..., {})`。跑 `prd` 確認不 break。
2. **加 `detectNeedsDesign`** — designer 條件式邏輯。
3. **加 `runExplore`** — 新函式，獨立測試。
4. **加 `upsertPortComment`** — 新函式，獨立測試。
5. **加 `port` handler** — 組合 1-4。
6. **加 `portff` handler** — port + ff hand off。
7. **修改 `update` handler** — 偵測 port ticket → upsert Linear。
8. **更新 `.env.example` + `CLAUDE.md`**。
