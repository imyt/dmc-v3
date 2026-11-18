# 0020. Sign-in by session cookie (resolves F4b)

Status: accepted

## Decision
In UAT and prod the corporate sign-in authenticates the person and sets a `dmc_session` cookie. The cookie value is base64url JSON `{displayName, staffID, groups}` (groups are the person's Active Directory groups), followed by `.` and an HMAC-SHA256 signature made with `DMC_SECRET_SESSION`. The API reads it (`cookieAuthenticator`): `staffID` becomes the principal id, the groups go through the group-to-role mapping in `config/authz.yaml`, `displayName` is for screens only. The API does not start outside `local` without `DMC_SECRET_SESSION`, and never believes an unsigned or wrongly signed cookie. No new dependency (Node `crypto`).

In `local` only, `POST /v1/auth/mock-login {staffID, displayName, groups}` sets the same cookie (unsigned unless a secret is set), `GET /v1/auth/me` says who you are, `POST /v1/auth/logout` clears it. Mock login is a 404 in every other environment. The header authenticator keeps working in local for scripts and tests.

## Why
The user described the corporate behaviour: the gateway sets this cookie on successful authentication. Verifying a signature we share with the gateway is the smallest thing that is safe, and needs no token library or IdP call from DMC.

## Consequences
- The corporate gateway must sign the cookie with the same secret (a DMC_SECRET_SESSION shared with it) and set it HttpOnly, Secure, SameSite=Lax. If it will not sign, the alternative is a trusted-proxy header; revisit then.
- Sessions last as long as the cookie the gateway sets; DMC has no session store and no revocation list.
- Service accounts and agents still authenticate as before (they are not people with a cookie).
