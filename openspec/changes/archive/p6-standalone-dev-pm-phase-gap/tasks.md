## Tasks

- [ ] 1. 在 `runDevJob` 的 `!hasArtifacts` 路徑中，`runPMPhase` 完成後加入 `postArtifactsToSlack(changesDir, client, channelId, threadTs)`
- [ ] 2. 在 `postArtifactsToSlack` 後加入 commit + push（同 PRD flow 的 line 538-540 邏輯）
- [ ] 3. 修改該路徑的 approve 提示文案，告知使用者 artifacts 已生成，可 review 後 approve
