# Proposal: 修正 runSkill resume 時 model 不一致

## Problem

`runSkill` (line 883-929) 中，agent 類型（pm-agent, dev-agent）首次執行時用 `--agent label`，model 由 agent definition 決定（可能是 sonnet）。但 timeout resume 時 (line 894) 強制使用 `--model opus`。

這導致 resume 可能在不同 model 下繼續，行為可能不一致。

## Solution

Resume 時不硬編碼 `--model opus`。改為：
- 如果是 agent 類型，resume 也使用 `--agent` flag（讓 agent definition 決定 model）
- 或移除 resume 時的 `--model` 參數，讓 Claude CLI 使用 session 原本的 model

實際上 `--resume` 會恢復原 session，model 應該跟隨原 session。移除 `--model opus` 即可。

## Scope

- 只修改 `agent.js` 的 `runSkill` 函數

## Success Criteria

- Agent 類型的 skill resume 時不覆蓋 model
- 非 agent 類型（commit, format, code-review）resume 時保持 opus（因為首次就是 opus）
