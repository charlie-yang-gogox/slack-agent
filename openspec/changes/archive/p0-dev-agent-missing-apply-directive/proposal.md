# Proposal: dev-agent prompt 加入明確的 /opsx:apply 指令

## Problem

`runDevJob` Step 4b 透過 `runSkill("dev-agent", devContext)` 呼叫 dev-agent，但 `buildTicketContext()` 只產生 ticket metadata（title, description, branch, worktree）。

Prompt 完全沒有告訴 dev-agent：
- 要執行 `/opsx:apply`
- Artifacts 的 slug 或路徑
- 要執行 `/opsx:verify`
- 要跑測試

對比 orchestrator prompt (line 307-332) 明確寫了 `Run /opsx:ff {titleSlug}`，dev-agent 缺少同等的指令。導致 dev-agent 瞬間完成、不做任何實作。

## Solution

在 `runDevJob` 中，dev-agent 呼叫前組裝完整 prompt，包含：
1. Ticket context（現有的 `buildTicketContext`）
2. 明確的 `/opsx:apply {slug}` 指令
3. Artifacts 路徑提示
4. `/opsx:verify` + 測試指令
5. Permission bypass 聲明

從 `checkArtifacts()` 取得 artifact slug，組裝成類似 orchestrator 的結構化 prompt。

## Scope

- 只修改 `agent.js` 的 `runDevJob` 函數
- 不修改 `buildTicketContext()`（保持通用）
- 不修改 target repo 的 agent definitions

## Success Criteria

- dev-agent 收到的 prompt 包含 `/opsx:apply {slug}` 指令
- dev-agent 實際執行 apply + verify
- FF 和手動 dev 流程都使用相同的 dev prompt
