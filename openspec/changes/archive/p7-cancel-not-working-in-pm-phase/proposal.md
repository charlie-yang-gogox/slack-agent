# Proposal: 修正 cancel 在 PM phase 無法運作

## Problem

`runPMPhase` 的 `runAndValidate` 透過 `runAsync` 註冊 subprocess 時使用 composite key `${ticketId}:${sessionSuffix}`（例如 `CAF-195:pm`）。

但 `handleCancel` 用 `activeProcesses.get(ticketId)`（即 `CAF-195`）查找 → 找不到 → 回傳 "No running job found" → 提前 return → `cancelledTickets.add()` 未執行 → pm-agent/designer-agent 跑完後流程照常繼續。

## Solution

`runAndValidate` 的 `runAsync` 改用 `ticketId` 直接註冊（pm-agent 和 designer-agent 是 sequential 執行，不會互相覆蓋），同時傳入 `threadTs` 和 `channelId` 讓 cancel handler 能正確清理。

## Scope

- 只修改 `agent.js` 的 `runPMPhase` → `runAndValidate` 中 `runAsync` 的 opts

## Success Criteria

- `@PM cancel CAF-XXX` 在 pm-agent 或 designer-agent 執行期間能正確 kill process
- Cancel 後 `cancelledTickets` 被設置，後續步驟不再繼續
