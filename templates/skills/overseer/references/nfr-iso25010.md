# Non-functional requirements — ISO/IEC 25010:2023 categories

Use the `nfr_category` value exactly as written. Every NFR needs a measurable `fit_criterion`.

| `nfr_category` | Covers (sub-characteristics) | Elicitation prompts | Sample fit criteria |
|---|---|---|---|
| `performance_efficiency` | time behaviour, resource utilization, capacity | Expected load? Acceptable latency? Peak users? Hardware budget? | p95 latency < 300 ms at 100 rps; ≤ 512 MB RAM per instance; 10 000 concurrent sessions |
| `compatibility` | co-existence, interoperability | Which browsers/OS/devices? Which systems must it exchange data with? Formats/protocols? | Works on the last 2 versions of Chrome, Firefox, Safari, Edge; imports CSV RFC 4180 files |
| `interaction_capability` | recognizability, learnability, operability, user error protection, engagement, inclusivity, assistance, self-descriptiveness | Who are the users? Accessibility needs? Languages? Training available? | WCAG 2.2 AA; new user completes signup in < 2 min without help in 9/10 tests |
| `reliability` | faultlessness, availability, fault tolerance, recoverability | Allowed downtime? Data-loss tolerance? Behaviour when a dependency fails? | 99.9 % monthly availability; RPO ≤ 5 min, RTO ≤ 1 h |
| `security` | confidentiality, integrity, non-repudiation, accountability, authenticity, resistance | What data is sensitive? Who may access what? Compliance (GDPR, PCI)? Audit needs? | Passwords hashed with Argon2id; 0 critical/high findings in OWASP ASVS L2 review; admin actions audited |
| `maintainability` | modularity, reusability, analysability, modifiability, testability | Who maintains it? Release cadence? Test expectations? | ≥ 80 % line coverage on core modules; a new payment provider added in ≤ 3 days |
| `flexibility` | adaptability, scalability, installability, replaceability | Future platforms? Growth? Deployment targets? | Scales to 5× load by adding instances only; installs on a clean host in < 15 min |
| `safety` | operational constraint, risk identification, fail safe, hazard warning, safe integration | Can a failure harm people, property or environment? Required safe states? | On sensor loss, the controller enters the safe state within 200 ms |

Tips: avoid "fast", "secure", "scalable" without numbers; one quality per requirement; give the
measurement condition (load, environment, percentile) and `verification_method` (usually `test` or
`analysis`).

<!-- managed-by: overseer-cli -->
