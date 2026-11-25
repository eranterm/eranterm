# EranTerm

Local-first desktop SSH manager for your servers: terminals, an SFTP file manager with drag & drop, live log tailing with level colours and search, and an AI assistant that only runs commands you approve.

## Features
- **Home**: all servers with search, favorites, edit/delete, connect
- **File Manager**: browse, upload/download (drag & drop, folders as tar.gz), delete, open any folder in a side terminal or the main terminal
- **Terminal**: full xterm shell + AI command suggestions (approve before run)
- **Logs**: multiple sources per server, Live tail on/off, INFO/WARN/ERROR colours, 200–5000 lines, highlight or filter search, download

## Run
```bash
npm install
npm start
```

## Test
```bash
npm test
```

## Google sign-in & backup (one-time setup)
Each user signs in with their own Google account; their config is backed up to **their own Google Drive** (the app's hidden
`appDataFolder`). There is no server or database. Google only requires the app to be registered once as an OAuth client;
that registration holds no user data. Until `CONFIG` in `cloud.js` is filled in, Settings → Account says sign-in is not set up.

1. console.cloud.google.com → new project (e.g. **EranTerm**).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **Google Auth Platform** (OAuth consent screen): Branding = "EranTerm" + your email; Audience = External → **Publish app**;
   Data access = `openid`, `email`, `…/auth/drive.appdata`.
4. **Clients** → Create client → **Desktop app** → put its Client ID and Client secret in `CONFIG` at the top of `cloud.js`, then build.

Team sharing (a team file in an admin's Drive, shared with the team) and in-app feedback come next.

Passwords and the Anthropic API key are encrypted with the OS keychain (Electron `safeStorage`) and stay in the main process. Host keys are trusted on first use and pinned afterwards.
