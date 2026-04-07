## Tasks

### P1 — 移除 FF 多餘 approve 訊息
- [ ] 1.1 在 `runDevJob` 的 `hasArtifacts` 判斷中，FF 模式改為貼 "Artifacts found, starting implementation..." 而非 approve/reject 提示
- [ ] 1.2 同理處理 `!hasArtifacts` 路徑（line 852-854）的 approve 提示

### P2 — FF 不傳 threadContext 給 dev-agent
- [ ] 2.1 在 `runDevJob` 中，FF 模式跳過 `fetchThreadContext`（line 784），或在 `applyExtra` 組裝時排除
- [ ] 2.2 FF 模式下 `applyExtra` 只包含 `ffTicketExtras` 的使用者指令

### P4 — 修正 session name 顯示
- [ ] 4.1 更新完成訊息 (line 995) 中的 session 列表為實際 names

### P5 — FF 跳過重複 fetch
- [ ] 5.1 在 `runDevJob` Step 1，如果 `isFF` 且 ticket JSON 已存在，跳過 `fetch_ticket.py`
