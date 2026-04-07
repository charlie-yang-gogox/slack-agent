# Proposal: FF 模式 UX 清理 (P1 + P2 + P4 + P5)

## Problems

### P1 — FF 貼多餘 approve 訊息
FF 模式下 `runDevJob` 仍會貼 "Reply `approve` to start implementation..."，緊接著又貼 "Auto-approved (ff mode)"。第一條在 FF 下無意義且混亂。

### P2 — threadContext 灌入 artifact dump
FF 時 PM Bot 在 thread 貼完整 artifacts（`postArtifactsToSlack`），Dev Bot 在同 thread 觸發後 `fetchThreadContext()` 撈回所有訊息（含完整 artifact 文字），塞進 dev-agent prompt。造成 token 浪費、prompt 品質下降。

### P4 — Session name 顯示錯誤
完成訊息中顯示 `{ticketId}-ff`, `{ticketId}-opsx:apply`，但實際 session names 是 `{ticketId}-dev-agent`, `{ticketId}-commit` 等。使用者無法用顯示的名字 resume。

### P5 — FF 中 fetch_ticket 跑兩次
PM phase (line 584) 跑一次，Dev phase (line 817) 又跑一次，結果相同，浪費時間。

## Solution

### P1 fix
在 `hasArtifacts` 的通知判斷加入 `opts.isFF` 檢查：FF 模式只貼簡短確認（"Artifacts found, auto-starting..."），不貼 approve/reject 提示。

### P2 fix
FF 模式下跳過 `fetchThreadContext`，或過濾 threadContext 中的 code block（artifact dump）。建議方案：FF 時不傳 threadContext 給 dev-agent（artifacts 已經在 worktree 裡，不需要從 Slack 訊息中重複讀取）。改為只傳 `ffTicketExtras` 中的使用者指令。

### P4 fix
更新完成訊息的 session 列表，改為實際存在的 names：`{ticketId}-dev-agent`, `{ticketId}-commit`, `{ticketId}-format`, `{ticketId}-code-review`。

### P5 fix
在 `runDevJob` 開頭，如果 `isFF` 為 true 且 `/tmp/ticket-{ticketId}.json` 已存在，跳過 `fetch_ticket.py`。

## Scope

- 只修改 `agent.js` 的 `runDevJob` 函數
- 不影響 PRD 或 update 流程

## Success Criteria

- FF 模式不再顯示 approve/reject 提示
- dev-agent prompt 不包含 Slack artifact dump
- Session name 顯示正確，可用於 `claude --resume`
- FF 不重複 fetch ticket
