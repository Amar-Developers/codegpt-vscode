# Code GPT for VS Code

Code GPT by AMAR Developers: an AI coding agent inside your editor, with your Code GPT account, models and agents.

## What it does

- **Agent mode.** Tell it what you want ("fix the cart total bug", "add a CLI", "write tests for utils.py"). It searches your project, reads the files it needs, changes them and creates new ones. You see every step.
- **You review every change.** Each changed file gets a card with the diff. Open it in VS Code's diff editor, then **Accept** or **Reject** (per file, or all at once). Nothing is written until you accept, unless you switch on *Apply changes as it works* (then you **Keep** or **Undo**).
- **Runs your tests when you say so.** The agent can ask to run a command such as your tests. It shows the command and runs it only after you press **Run**, then reads the output and keeps fixing. Commands that can do real damage (`sudo`, `rm -rf /`, `curl … | sh`, force-push, publishing) are refused; risky ones (deleting files, network, global installs) ask you twice. You can also just copy the command or paste it into your terminal without running it.
- **Ask mode.** Questions about your code, answered in the panel, nothing changed. Code blocks have Copy, Insert and Replace selection.
- **Inline edit: `Ctrl+Alt+K`** (`Cmd+Alt+K` on Mac). Select code, say what should change, review the diff, accept or reject. With nothing selected it writes new code at the cursor.
- **@ mentions.** Type `@` to add project files, or one of your Code GPT agents, to a message.
- **Model picker.** Choose the model in the panel or from the status bar.
- **Right-click › Code GPT:** Explain, Find and fix bugs, Improve, Write tests, Add comments, Add to chat. A **Fix with Code GPT** quick fix appears on errors and warnings.
- **Shows what is sent.** "What is sent?" under the message box lists exactly what left your computer on the last step.

## Your secrets stay on your computer

- `.env` files, private keys, certificates, credentials files and the `.git` folder are never read, listed, searched, sent or changed.
- Values that look like secrets in other files (API keys, tokens, `password = "…"`, private key blocks, passwords in URLs) are replaced with `«hidden»` before anything is sent, also in command output.
- Text inside your files is treated as data, never as instructions to the agent.
- Your Code GPT key is kept in VS Code's secret storage.

## Not included (yet)

To be clear about what this version does not do:

- No Tab autocomplete while you type.
- No codebase index or embeddings: the agent finds code with text search and by reading files.
- Commands never run automatically, and the agent cannot start servers or watchers (2 minute limit, no keyboard input).
- No background or cloud agents: the agent works while the panel task runs.
- Multi-root workspaces: the agent works in the first folder.

## Limits

Agent steps per day depend on your plan (Free 30, Pro 800, Business 3,000; your admin can change these). Ask mode uses your normal message limit.

## Getting started

1. Click the Code GPT icon in the Activity Bar.
2. Click **Connect your account** and press **Allow** in the browser.
3. Open a folder, type a task, and press Enter.

No account? Create one free at [codegpt.it.com](https://codegpt.it.com).
