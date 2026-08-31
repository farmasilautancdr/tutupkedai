# Project Memory — TutupKedai PRO

Append-only running log of project context: decisions, features, bugs fixed, in-progress work, and user preferences for this project. Newest entries at the bottom. See `CLAUDE.md` for the instruction to keep this updated automatically.

## 2026-08-31

- Set up `CLAUDE.md` and this `MEMORY.md` at the user's request, so future sessions in this project don't require re-explaining context. Claude is authorized to append to this file automatically whenever something worth remembering happens, without asking permission first.
- Project recap at time of setup: single-file vanilla JS/HTML/CSS PWA (`index.html`), no build tooling. Purpose: multi-outlet, multi-terminal POS closing scanner + bank deposit calculator. Uses Tesseract.js (CDN) for OCR of photographed POS receipt totals, and `localStorage` (keys prefixed `tk_`) for all persistence — no backend. Service worker (`sw.js`, cache `tutupkedai-v2.4`) makes it installable/offline-capable.
- No git repository exists in this directory yet.
- Added `origin` remote (`https://github.com/farmasilautancdr/tutupkedai.git`) and pushed `master` (tracking `origin/master`). Repo owner is `farmasilautancdr`, not the user's personal GitHub — note for future push/PR/issue actions.
- Initialized git repo and made the initial commit (`1ad641f`, 8 files: all project files + `.gitignore` excluding `.claude/settings.local.json`). Updated `CLAUDE.md` (was saying "not a git repo yet") to reflect it. `master` branch, no remote configured.
- Rewrote `CLAUDE.md` to match the user's standard personal template (`C:\Users\Client\Desktop\CLAUDE.md`): CORE rules, "About me", PATHS & COMMANDS, HARD RULES, memory workflow. Adapted stack line to this project's actual stack (static vanilla PWA, no Vue/Node/Postgres — those are from a different project). Dropped the template's Plugins section (`/frontend-design`, `/superpowers`, `/context7`, `/caveman`, `/ui-ux-pro-max`) — none of those custom commands exist in this environment, so listing them here would be misleading. Also corrected the "bilingual BM/EN" rule: this codebase's UI text is English-only, not bilingual.
