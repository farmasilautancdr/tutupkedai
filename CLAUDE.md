# CLAUDE.md — TutupKedai PRO

Multi-outlet, multi-terminal POS closing scanner and bank deposit calculator. End-of-day flow: staff photograph each POS terminal's closing total, OCR reads the number off the receipt, app computes the bank deposit (total sales minus float) per outlet.

# CORE
1. Read `MEMORY.md` on boot.
2. Auto-write to `MEMORY.md` without asking. Keep entries ultra-brief.
3. Move old/resolved items from `MEMORY.md` to `ARCHIVE.md` if `MEMORY.md` starts bloating.
4. Log all mistakes & fixes. Never repeat them.
5. Upon task completion, summarize outcomes to `MEMORY.md`, then prompt the user to `/clear` chat history to reset token burn.
6. Stack: static single-page PWA — vanilla HTML/CSS/JS in `index.html`, no build system, no package manager, no framework/bundler. Tesseract.js (CDN) for OCR. `localStorage` is the offline cache; Google Drive (via a Vercel serverless function, `api/outlet.js`) is the source of truth for outlet config + scan history, synced across terminals. No new dependency added without asking first.

# About me
I'm a self-taught "vibe coder" — no formal CS background, learned by building this in production. I work fast and expect direct, no-filler answers. I primarily work in Bahasa Malaysia for business context. This particular codebase's UI text is currently English-only (not bilingual like other projects) — ask before adding Malay strings rather than assuming BM/EN parity is wanted here.

# PATHS & COMMANDS
- App Root: `/` (repo root) — everything is in `index.html`, `manifest.json`, `sw.js`, `icon.png`.
- Run it: open `index.html` directly for quick UI checks, but the service worker (`sw.js`) and full offline/install behavior only register over `http(s)://`, not `file://` — serve the folder with any static server (e.g. `npx serve .` or `python -m http.server`) to test PWA/OCR end-to-end.
- Root Files: `CLAUDE.md`, `MEMORY.md`.

# HARD RULES
- **Ask First:** Never assume ambiguous fields, data shapes, or locations.
- **Show the Plan:** Before touching files for anything beyond a 1-line fix, explain the changes and wait for clearance.
- **Verify Programmatically:** Test end-to-end in the browser (serve + click through the flow, check `localStorage`/console), don't just eyeball the diff. State exactly *how* it was verified.
- **Scope Strictness:** Don't touch unrelated code/bugs unless asked. Don't expand scope silently.
- **Honesty:** Flag fragile workarounds explicitly. Don't present hacks as clean fixes.
- **Style:** Terse, no filler. Match existing file conventions (CSS custom properties, `tk_`-prefixed localStorage keys, function-per-screen structure) over textbook best practices.
- **No build creep:** Keep the no-build, single-file, vanilla-JS approach — don't introduce a bundler/framework/dependency without asking.
- **Cache bump:** Any change to a cached asset (`index.html`, `manifest.json`, or the Tesseract CDN URL) needs `CACHE_NAME` bumped in `sw.js` (currently `tutupkedai-v2.5`), or returning users keep serving stale files.

# ARCHITECTURE NOTES
- **OCR pipeline:** `processImage` → crop modal → `preprocessForOCR` → `runOCR` → `parseReceiptText`.
- **Data model:** outlets keyed by a short user-chosen code; each has a configured POS terminal count + float amount (`tk_outletConfig`); each outlet's scan history lives separately under `tk_data_<code>`; per-outlet undo via `tk_undo_<code>` (undo snapshots are local-only, not synced to Drive).
- **UI:** hand-rolled screens toggled via `showScreen(name)`, no router/framework. Dark/light theme persisted via `tk_theme`.
- **Google Drive sync (`api/outlet.js`, `GET`/`POST /api/outlet?code=<code>`):** frontend calls this from `chooseOutlet`, `loadOutletData`, and every place that mutates `outletConfig`/`scanHistory` (see `syncOutletToDrive`/`fetchOutletFromDrive` in `index.html`). Auth is a Google **service account** (JWT-signed by hand in `api/outlet.js`, no `googleapis` dependency, no per-user login). All outlets live inside **one combined file**, `tutupkedai-data.json`, in the shared Drive folder — **not** one file per outlet.
  - **Why one file, not one-per-outlet:** service accounts have zero Drive storage quota of their own — they can *update* a file they don't own but cannot *create* a new one in someone else's folder (`storageQuotaExceeded`) unless you're on paid Google Workspace Shared Drives. Discovered by testing against the real folder, not guessed. Workaround: a human creates `tutupkedai-data.json` (containing `{"outlets":{}}`) once, by hand, in the shared folder; the API only ever PATCHes it afterward.
  - **If that data file is ever deleted**, Drive sync breaks with a 503 from `api/outlet.js` until a human re-uploads an empty `{"outlets":{}}` file with that exact name to the shared folder — the API cannot recreate it itself.
  - **Known race:** read-modify-write of the whole shared file per save. Fine at this app's real-world scale (staff saving sequentially), but two terminals saving *different* outlets in the same instant could theoretically clobber each other. Not solved (no Drive revision/etag locking) — acceptable tradeoff, not an oversight.
  - Required Vercel env vars: `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_FOLDER_ID`. Never commit the raw service-account JSON key.
  - `VALID_CODES` in `api/outlet.js` mirrors `allOutlets` in `index.html` — keep both lists in sync if outlets are added/removed.
- Git repo, `main` branch (tracks `origin/main`), remote `origin` → `https://github.com/farmasilautancdr/tutupkedai.git`. This local folder was originally a downloaded snapshot of that repo's `main` branch (no `.git`), so treat `origin/main` as the canonical history — don't recreate a disconnected local history again.
- Single large `index.html`: use Grep to jump to the relevant function rather than reading the whole file.

# PLUGINS
Installed at user scope (`~/.claude`), so available in every project, not just this one:
- `frontend-design` — distinctive, intentional UI/UX design guidance instead of templated defaults.
- `superpowers` — brainstorming, TDD, systematic debugging, code review, and planning workflows (`superpowers:*` skills).
- `context7` — fetches current library/framework docs instead of relying on training data.
- `playwright` — drives a real browser (click, fill, screenshot, console/network inspection) for end-to-end verification.
- `caveman` — terse-mode hooks (extreme brevity, no filler) installed via the `JuliusBrussee/caveman` marketplace.
- `ui-ux-pro-max` (`uipro`, npm global + `~/.claude/skills/`) — UI/UX pattern/design-token skill for generating production-grade frontend UI.

# PERSISTENT MEMORY
`MEMORY.md` in the repo root is an append-only running log: decisions, features built, bugs fixed and their cause, in-progress work, user preferences specific to this project. Read it first each session so the user never has to re-explain prior context. Append to it immediately whenever something worth remembering happens — no permission needed. Don't log what's obvious from re-reading the code; log the *why*.
