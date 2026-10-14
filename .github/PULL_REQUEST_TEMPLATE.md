## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem, not the diff. If it fixes an issue, link it: Fixes #123 -->

## How it was verified

<!-- Exact commands and their result. Say "not run" if you did not run one; that is fine
     and far better than guessing. -->

- [ ] `make test` (integration sweep, needs `make dev` first)
- [ ] `make test-go` (gofmt, vet, race tests)
- [ ] `make smoke` (every route renders)
- [ ] Manual check in the browser, described below

```
paste the relevant output here
```

## Checklist

- [ ] New behaviour has a test that fails without the change
- [ ] No money rule added outside the Go settlement core
- [ ] If `frontend/api/index.js` changed, `mock-api-server.js` was checked for the same change
- [ ] Nothing simulated is described as live, in code, UI or docs
- [ ] No secrets, keys or credentials in the diff

## Anything a reviewer should look at carefully

<!-- Known weak spots, trade-offs you made, things you were unsure about. -->
