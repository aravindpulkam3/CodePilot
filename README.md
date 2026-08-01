# AI Engineering Workspace — Auth & Foundation Milestone

This milestone ships the authentication system and application shell for
AI Engineering Workspace. **No AI features, repository indexing, or
GitHub API integration are implemented** — the architecture is shaped so
those modules slot in later without a rewrite.

```
ai-engineering-workspace/
├── frontend/    React + Vite + TypeScript + Tailwind + Clerk
└── backend/     Node + Express + TypeScript + PostgreSQL + Clerk
```

---

## 1. Setup instructions

### Prerequisites
- Node.js 18+
- A PostgreSQL database (local or hosted)
- A free [Clerk](https://clerk.com) account

### 1.1 Clerk Dashboard setup
1. Create a Clerk application at https://dashboard.clerk.com.
2. **Enable email/password**: User & Authentication → Email, Phone,
   Username → turn on "Email address" + "Password".
3. **Enable GitHub OAuth**: User & Authentication → Social Connections →
   enable **GitHub**. For production, register your own GitHub OAuth App
   (GitHub → Settings → Developer settings → OAuth Apps) and paste its
   Client ID/Secret into Clerk; Clerk's shared dev credentials work fine
   for local development with no extra setup.
4. Copy your keys from **API Keys**:
   - `Publishable key` → frontend
   - `Secret key` → backend
5. (Optional, for DB sync) **Webhooks** → Add Endpoint →
   `http://localhost:4000/api/webhooks/clerk` (use a tunnel like ngrok
   for a real endpoint locally) → subscribe to `user.created`,
   `user.updated`, `user.deleted` → copy the **Signing Secret**.

### 1.2 Backend
```bash
cd backend
cp .env.example .env
# fill in CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, DATABASE_URL
# (CLERK_WEBHOOK_SIGNING_SECRET is optional until you wire up webhooks)
npm install
npm run migrate   # applies backend/src/db/schema.sql
npm run dev        # http://localhost:4000
```

### 1.3 Frontend
```bash
cd frontend
cp .env.example .env.local
# fill in VITE_CLERK_PUBLISHABLE_KEY
npm install
npm run dev         # http://localhost:5173
```

Sign up, sign in, and sign out all work end-to-end once both keys are
set — the project compiles and runs with no other changes.

---

## 2. Architectural decisions

**Clerk owns all authentication.** No custom JWTs, no bcrypt, no
hand-rolled sessions. `<ClerkProvider>` wraps the app once
(`frontend/src/providers/ClerkProviderWrapper.tsx`); `<SignIn>`/`<SignUp>`
(Clerk components) render both email/password and "Continue with GitHub"
automatically based on what's enabled in the Dashboard — enabling a new
provider there is the only step to add one here, no frontend changes.

**Route guarding is declarative**, not per-page checks.
`ProtectedRoute` and `PublicOnlyRoute`
(`frontend/src/features/auth/`) are layout routes in
`frontend/src/routes/index.tsx`: everything nested under
`<ProtectedRoute>` requires a session, everything under
`<PublicOnlyRoute>` (Login/Signup) redirects away *from* a session. Both
wait for `isLoaded` before deciding, so a signed-in user never flashes
through the login screen on refresh.

**The database never sees a password.** `app_users` (see
`backend/src/db/schema.sql`) stores only application data —
`clerk_id`, email, name, avatar, GitHub-connection status — keyed to
Clerk's own user id. It's kept in sync two ways: lazily (the `/api/users/me`
endpoint creates a row on first authenticated call if one doesn't exist
yet) and via the Clerk webhook (`backend/src/routes/webhook.routes.ts`),
which is the source of truth once configured. The frontend's
`AppUser`/backend's `AppUserDto` types mirror this table 1:1.

**The API layer exists before there's anything real to call.**
`frontend/src/services/api/` wraps `axios` with the Clerk session token
attached automatically (`useApiClient`), and React Query
(`useCurrentUser`) owns caching. Future features add a file here and a
hook, not a new pattern.

**Folder structure is grouped by concern, not by file type**, so a
future module (AI Chat, repo indexing, LangGraph) is additive:
- `components/` — layout chrome and generic UI primitives (Button,
  Card, Badge…), no feature logic
- `features/` — one folder per capability; today only `auth/` has real
  code, the rest (`dashboard/`, `repositories/`, …) are reserved
- `pages/` — route-level components; today all "blueprint" pages
  (title + placeholder), swapped for real UI as features land
- `routes/` — the single route tree
- `services/api/` — all backend calls
- On the backend, `routes/ → controllers/ → services/` keeps SQL out of
  route handlers and route handlers out of business logic, so a
  `repositories.routes.ts` + `repository.controller.ts` +
  `repository.service.ts` triad drops in the same way `user.*` does today.

**Design.** The UI intentionally avoids the current "AI-generated
product" look (cream + terracotta, or black + neon violet). It uses a
graphite/paper neutral palette with a signal-teal accent, Space Grotesk
for display type, Inter for UI text, and JetBrains Mono for technical
detail — meant to read as a developer tool, not a generic SaaS template.

---

## 3. What's deliberately not built yet

Per the brief, these are out of scope for this milestone. The folders,
routes, and DB schema comments mark where each will attach:
AI Chat, repository indexing, GitHub repository APIs, vector database,
embeddings, documentation generation, pull request review, LangChain/
LangGraph, Python service.
