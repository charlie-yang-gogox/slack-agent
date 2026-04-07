## Tasks

- [ ] 1. 在 `runDevJob` 中 `runSkill("dev-agent")` 之前，用 `checkArtifacts(changesDir)` 取得 artifact dirs
- [ ] 2. 組裝 dev prompt，包含：ticket context + `/opsx:apply {slug}` + `/opsx:verify` + 測試指令 + permission bypass
- [ ] 3. 將 `runSkill("dev-agent", devContext)` 改為 `runSkill("dev-agent", devPrompt)`
- [ ] 4. 確保 `applyExtra`（thread context / extra instructions）仍被包含在 prompt 中
