# Hackathon Opportunity Radar seed

This is a clean target repository seed, not a completed application. The architecture task creates the API contract, shared types, integration shell, and acceptance tests before parallel coding begins.

The orchestrator must copy its validated, run-scoped shared-disk research dataset to `data/research.json` in the architecture workspace. Coding tasks must consume that file without network access. The dataset remains unchanged by product code.

After delivery, run `npm install`, `npm test`, and `npm start` from the delivered target checkout. The app listens on port 3000. `npm run typecheck` checks TypeScript. This initial seed has no app source; those commands become useful after workers implement the tasks.

`fixtures/radar-agent` in the swarm repository contains canned task outputs for explicitly labeled local pipeline tests. Copying those outputs is not a live coding-agent run. A real run must execute Codex in Archil sandboxes and verify the resulting PRs.

The finished UI stores only event IDs in the browser under `radar:<runId>:shortlist`. Distinct run IDs keep rehearsals and judges' selections separate. Research provenance, source timestamps, unknowns, and conflicts remain visible through the product's evidence view.
