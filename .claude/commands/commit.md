Commit all staged and unstaged changes in the current repository.

## Steps

1. Run `git status` to see all changes (staged, unstaged, untracked)
2. Run `git diff` to review what will be committed
3. Run `git log --oneline -5` to see recent commit message style
4. Stage all relevant changes with `git add` (specific files, not `git add -A` — avoid .env or credentials)
5. Write a concise commit message that:
   - Summarizes the nature of the changes (feat, fix, chore, refactor, etc.)
   - Focuses on the "why" rather than the "what"
   - Follows the style of recent commits in the repo
6. Create the commit

Do NOT push to remote. Do NOT ask for confirmation — just commit.
