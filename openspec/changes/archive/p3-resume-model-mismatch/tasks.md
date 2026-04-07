## Tasks

- [ ] 1. 在 `runSkill` 的 resume 分支 (line 893-894)，根據 `isAgent` 決定 resume args：
  - `isAgent=true` → `["--print", "--dangerously-skip-permissions", "--resume", sessionName]`（不帶 `--model`）
  - `isAgent=false` → 保持現有 `["--print", "--dangerously-skip-permissions", "--model", "opus", "--resume", sessionName]`
