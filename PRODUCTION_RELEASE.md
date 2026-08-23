# SEISEKI production release

- outcome: success
- production_url: https://seiseki-api.tokyo-odh-129.workers.dev
- worker: seiseki-api
- d1_database: seiseki-db
- d1_database_id: 8ad5e023-3588-490c-ba61-3f180f8b2887
- d1_created_during_release: false
- analysis_queue: seiseki-analysis
- queue_created_during_release: false
- workers_ai: enabled
- allowed_origins: https://seiseki-api.tokyo-odh-129.workers.dev
- turnstile_required: false
- application_rate_limits: enabled
- runtime_mode: production
- typography: Hiragino-first; external Google Fonts removed; font synthesis disabled
- quantum_preview: stable 10000-node synthetic demo; no production D1 binding
- quantum_glow_experiment_archive: archive/quantum-relation-glow-20260823
- production_health: ok
- release_guard: DB_API isolated to D1; assets built before dry-run; strict deploy; D1 Time Travel checkpoint
