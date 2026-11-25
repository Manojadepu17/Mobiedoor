# MobieDoor Phases 3, 4A, and 4B Review

## Scope

Read-only review of the working tree on `feature/catalogue-reliability-phase-3`, against base commit `ff896f6`. No production requests or database mutations were made.

## Security finding

| Severity | Files | Lines | Finding / status | Confidence |
|---|---|---|---|---|
| Low | `apps/frontend/src/catalogue-validation.ts`, `apps/frontend/src/main.tsx` | 33-38, 508 | **RESOLVED.** Catalogue validation now accepts HTTPS Cloudinary images, explicitly approved local assets, and constrained existing `/uploads/<filename>` paths; it rejects protocol-relative URLs such as `//host`, unsupported external URLs, and unsafe schemes. Brand sample images now use the same `FallbackImage` validated rendering and fallback mechanism as other catalogue images. | 10/10 |

No other confirmed exploitable vulnerability was identified in the reviewed changes.

## Phase results and limitations

- **Phase 3:** Catalogue validation, pagination, transient read retries, and last-known-good cache behavior remain intact. Cache writes occur after successful validation of the complete catalogue. Deduplicated GET callers can cancel independently: the shared request continues while any caller remains active and aborts when all callers cancel. Shared request state is cleaned up after timeout and network failure. The per-snapshot maximum is enforced, but localStorage does not have a global cap across distinct catalogue query variants; browser quota failures can prevent later cache writes.
- **Phase 4A:** Login and registration submissions are guarded against duplicate submissions; authentication query failures preserve previously verified identity; confirmed unauthorized responses clear private auth-related query data without clearing public catalogue data. Authentication/session architecture was not changed by the reviewed diff.
- **Phase 4B:** Unknown and incorrect-password login paths perform dummy/real bcrypt verification and return equivalent invalid-credential responses. Successful login attempts do not consume the invalid-credential allowance. The 60-per-minute login request limiter and 30-per-15-minute registration limiter can still affect legitimate users sharing an IP; this is a documented operational trade-off. The invalid-credential limit is 20 per 15 minutes per IP.

## Unverified assumptions and infrastructure risks

- `TRUST_PROXY=1` is configured, but the Vercel-to-Render forwarded-header chain was not independently established. Spoofing resistance cannot be confirmed from repository code alone.
- Rate-limit state uses process-local `express-rate-limit` MemoryStore: it is not shared across instances and has no hard key-count capacity bound. Expiry cleans up inactive entries, but high-cardinality source IPs can increase memory use.
- Email normalization is applied in application code. Case-insensitive behavior for legacy mixed-case database rows depends on the deployed MySQL/TiDB collation and was not verified against a database.
- Database integration tests were skipped because `TEST_DATABASE_URL` was not set. Transactional registration, independent sessions, and database-backed expiry behavior therefore have code-level review but no integration-test confirmation in this run.
- The frontend image-cache tests do not establish a total localStorage cap across arbitrary query variants.

## Validation

- Backend: 57 tests passed; 2 database-gated tests skipped.
- Frontend: 103 tests passed; 0 failed across 11 test files.
- Backend and frontend TypeScript checks passed, including the frontend typecheck after the API client cancellation correction.
- Backend and frontend production builds passed. The frontend build used `VITE_API_URL=/api` only in the build process environment; no persistent environment setting was changed.
- `git diff --check` passed.

## Recommendation

**Not a production-readiness determination.** The image URL finding is resolved, but shared-IP rate-limit behavior, proxy-chain trust, MemoryStore limits, deployed database collation, and database-backed behavior remain risks or unverified assumptions that must be accepted or separately verified. This review does not claim that all risks are eliminated or verify production configuration or database behavior.
