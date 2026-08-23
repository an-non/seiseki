# SEISEKI production release progress

- outcome: incomplete
- workflow_source: main/.github/workflows/production-release-dbapi.yml
- release_branch: feature/quantum-app-integration
- checkout: success
- credentials: success
- candidate: success
- worker_tests: success
- d1: success
- queue: success
- bindings: failure
- build: skipped
- remote_state: skipped
- config_commit: skipped
- reinstall: skipped
- d1_checkpoint: skipped
- migrations: skipped
- rebuild: skipped
- deploy: skipped
- smoke: skipped
- release_record: skipped
- rollback_policy: Worker rollback after failed smoke; D1 Time Travel restore after any post-migration release failure

The first failed step above is the current blocker. No secret values are written here.
