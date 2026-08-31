# CLAUDE.md — TutupKedai PRO

Multi-outlet, multi-terminal POS closing scanner and bank deposit calculator. End-of-day flow: staff photograph each POS terminal's closing total, OCR reads the number off the receipt, app computes the bank deposit (total sales minus float) per outlet.

# CORE
1. Read `MEMORY.md` on boot.
2. Auto-write to `MEMORY.md` without asking. Keep entries ultra-brief.
3. Move old/resolved items from `MEMORY.md` to `ARCHIVE.md` if `MEMORY.md` starts bloating.
4. Log all mistakes & fixes. Never repeat them.
5. Upon task completion, summarize outcomes to `MEMORY.md`, then prompt the user to `/clear` chat history to reset token burn.
6. Stack: static single-page PWA — vanilla HTML/CSS/JS in `index.html`, no build system, no package manager, no backend. Tesseract.js (CDN) for OCR. `localStorage` for all persistence. No framework/bundler/dependency added without asking first.

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
- **Cache bump:** Any change to a cached asset (`index.html`, `manifest.json`, or the Tesseract CDN URL) needs `CACHE_NAME` bumped in `sw.js` (currently `tutupkedai-v2.4`), or returning users keep serving stale files.

# ARCHITECTURE NOTES
- **OCR pipeline:** `processImage` → crop modal → `preprocessForOCR` → `runOCR` → `parseReceiptText`.
- **Data model:** outlets keyed by a short user-chosen code; each has a configured POS terminal count + float amount (`tk_outletConfig`); each outlet's scan history lives separately under `tk_data_<code>`; per-outlet undo via `tk_undo_<code>`.
- **UI:** hand-rolled screens toggled via `showScreen(name)`, no router/framework. Dark/light theme persisted via `tk_theme`.
- Git repo, `main` branch (tracks `origin/main`), remote `origin` → `https://github.com/farmasilautancdr/tutupkedai.git`. This local folder was originally a downloaded snapshot of that repo's `main` branch (no `.git`), so treat `origin/main` as the canonical history — don't recreate a disconnected local history again.
- Single large `index.html`: use Grep to jump to the relevant function rather than reading the whole file.

# PERSISTENT MEMORY
`MEMORY.md` in the repo root is an append-only running log: decisions, features built, bugs fixed and their cause, in-progress work, user preferences specific to this project. Read it first each session so the user never has to re-explain prior context. Append to it immediately whenever something worth remembering happens — no permission needed. Don't log what's obvious from re-reading the code; log the *why*.
