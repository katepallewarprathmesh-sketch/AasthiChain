# Clerk Auth Integration — AasthiChain v1.8

## Overview
AasthiChain now supports **Clerk** for production-ready authentication while retaining mock auth fallback for hackathon demo.

- When `VITE_CLERK_PUBLISHABLE_KEY` is set → Clerk flow
- When not set or placeholder → legacy mock auth (originator1, registrar1, investor1, etc)

## Why Clerk?
- Email + password, OAuth (Google, GitHub), MFA, session management
- Secure JWT that backend can verify
- UserButton, SignIn, SignUp components out of box
- No custom auth to maintain

## Setup (2 minutes)

### 1. Create Clerk Application
1. Go to https://dashboard.clerk.com
2. Create Application → Name: `AasthiChain`
3. Enable Email + Google (optional)
4. Copy **Publishable Key** (`pk_test_...` or `pk_live_...`)

### 2. Configure Frontend
```bash
# frontend/.env
VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Restart dev server:
```bash
cd frontend && npm run dev
```

App auto-detects key and switches to Clerk. You’ll see “Clerk” badge in nav.

### 3. Configure Backend (Optional but Recommended)

#### Node Mock Server (mock-api-server.js)
Already supports Clerk tokens — decodes JWT without verification for demo and uses `X-Fabric-Identity` header to map to Fabric roles.

No extra config needed.

#### Go Gateway (api-gateway)
Update `api-gateway/middleware/auth.go` already handles Clerk JWTs:
- Tries HS256 first (legacy)
- If fails, tries to decode as Clerk JWT (checks `sub`, `iss` contains clerk)
- Uses `X-Fabric-Identity` header to map to Fabric MSP:
  - `originator1` → OriginatorMSP
  - `registrar1` → RegistrarMSP
  - `investor1`, `investor2` → InvestorMSP
  - `regulator1` → RegulatorMSP

For production verification, add JWKS verification:
```go
// In production, verify Clerk JWT via JWKS
// Set env: CLERK_JWKS_URL=https://your-domain.clerk.accounts.dev/.well-known/jwks.json
```

### 4. Fabric Role Mapping (Demo-Only)

Clerk handles **identity**; Fabric role is demo-only mapping per §5.4.

- After Clerk sign-in, user selects Fabric role via dropdown (originator1, registrar1, etc)
- Selection stored in `localStorage.aasthi_clerk_demo_identity`
- Internal `aasthi_user` object keeps both:
  ```json
  {
    "identityId": "investor1",
    "role": "Investor",
    "mspId": "InvestorMSP",
    "clerkId": "user_2abc...",
    "clerkEmail": "user@example.com",
    "token": "<clerk JWT>",
    "fabricMode": "clerk"
  }
  ```

- Backend receives `Authorization: Bearer <clerk JWT>` + `X-Fabric-Identity: investor1`
- Mock server maps to KYC-verified demo identity for ledger compatibility

To use Clerk metadata for role (advanced):
- Set `publicMetadata.fabricRole` in Clerk dashboard → Users → Metadata
- e.g., `{"fabricRole": "Originator"}` → auto-maps to originator1

## UI Flow

### With Clerk
1. `/login` shows role selector + Clerk `<SignIn />` component
2. User signs in via Clerk (email, OAuth, etc)
3. `useUser()` + `getToken()` → create `aasthi_user` with selected Fabric role
4. Redirect to `/marketplace`
5. Nav shows: Demo Role switcher + email + `UserButton` + Sign out (Clerk signOut)

### Without Clerk (Fallback)
1. `/login` shows presets (originator1, registrar1, etc) + mock login
2. Mock JWT via `btoa(JSON.stringify({identityId, role, mspId}))`
3. Same nav but no Clerk badge

## Files Changed

- `frontend/package.json` → added `@clerk/clerk-react`, `@clerk/react`
- `frontend/.env` + `.env.example` → `VITE_CLERK_PUBLISHABLE_KEY`
- `frontend/src/main.jsx` → `ClerkProvider` wrapper + fetch interceptor for `X-Fabric-Identity`
- `frontend/src/App.jsx` → dual mode: `LegacyRoot` vs `ClerkRoot`, `NavLegacy` vs `NavClerk`, `AppContentClerk` uses `useUser`, `useAuth`, `useClerk`, `UserButton`
- `frontend/src/pages/Login.jsx` → `ClerkLogin` (role selector + `<SignIn>`) + `LegacyLogin` fallback
- `frontend/src/lib/api.js` → helper for auth headers
- `mock-api-server.js` → `decodeClerkOrMockToken()`, handles Clerk JWT + `X-Fabric-Identity`
- `api-gateway/middleware/auth.go` → `tryDecodeClerkToken()`, supports Clerk JWT + header mapping

## Security Notes

- Clerk JWT is real, not mock — backend can verify via JWKS in production
- Mock server decodes without verification for demo speed; Go gateway does same but can be upgraded to full verification
- `X-Fabric-Identity` is trusted only because token is Clerk-verified (in prod, verify JWT signature first)
- Fabric MSP mapping is demo-only; production would map Clerk user to real Fabric CA enrollment

## Testing

### Without Clerk Key (default)
```bash
cd frontend && npm run dev
# Go to http://localhost:5173/login
# Should see "Clerk not configured — mock auth"
# Login as investor1 → marketplace works
```

### With Clerk Key
```bash
# Set real key in frontend/.env
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...

npm run dev
# Should see Clerk badge in nav
# /login shows Clerk SignIn + role selector
# Sign in → select role → marketplace
# Check localStorage: aasthi_user.fabricMode === 'clerk'
# Check Network: /api/* requests have Authorization: Bearer <clerk JWT> + X-Fabric-Identity
```

## Troubleshooting

- **ClerkProvider error**: Check key starts with `pk_` and is not placeholder
- **Blank screen**: Ensure `frontend/.env` exists and dev server restarted after changing key
- **401 on API**: Mock server allows any token but Go gateway needs header — fetch interceptor adds it automatically
- **Role not switching**: `localStorage.aasthi_clerk_demo_identity` stores selection — clear storage to reset

## Future Improvements

- Full JWKS verification in Go gateway (use `github.com/MicahParks/keyfunc` + Clerk JWKS URL)
- Map Clerk orgs to Fabric MSPs (Clerk Organizations → OriginatorMSP, etc)
- Store Fabric enrollment cert in Clerk `privateMetadata`
- Webhook: Clerk `user.created` → auto-create Fabric CA identity + KYC record
