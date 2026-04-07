# Proposal: 獨立 @Dev 觸發 PM phase 缺乏 review loop

## Problem

當使用者直接 `@Dev TICKET-ID`（沒有先跑 PRD），若 artifacts 不存在，`runDevJob` 會直接跑 `runPMPhase()`。但：

1. 不會 `postArtifactsToSlack`（只貼 truncated summary）
2. 使用者無法用 `@PM update` 修改 artifacts
3. 等於繞過 PM review，變成無 feedback loop 的 FF

## Solution

在 `runDevJob` 的 `!hasArtifacts` 路徑中：
1. 跑完 `runPMPhase` 後，呼叫 `postArtifactsToSlack` 貼完整 artifacts
2. Commit + push artifacts（同 PRD flow）
3. 然後再等 approve（現有行為），讓使用者有機會看完整 artifacts 後決定

這樣獨立 dev flow 在 artifacts 不存在時，行為接近 PRD + Dev 兩步流程。

## Scope

- 只修改 `agent.js` 的 `runDevJob` 的 `!hasArtifacts` 分支
- 不改 PM 的 update handler

## Success Criteria

- `@Dev TICKET-ID`（無 artifacts）→ PM phase → 完整 artifacts 貼到 Slack → 等 approve
- 使用者可在 approve 前看到所有 artifact 內容
