# Submission readiness checklist

## Current assessment

The repository is technically close, but the submission is **not ready to send** until the external items below are complete. The code builds, the automated suite passes, the dependency audit is clean, and the required architecture and narrative materials exist.

## Blocking before submission

- [ ] Replace the placeholder Slack request, interactivity, and OAuth URLs in `manifest.json` with the deployed HTTPS origin.
- [ ] Confirm whether the existing Slack app is grandfathered on `assistant_view`. New Slack apps require `agent_view`; migration is one-way and should be rehearsed with `message.im`, `app_home_opened`, and `app_context_changed` handling before changing the manifest.
- [ ] Set and verify the durable production variables listed in `DEMO_WORKSPACE.md`.
- [ ] Run one end-to-end Slack rehearsal from mention through cited result and thread follow-up.
- [ ] Export the Mermaid diagram in `ARCHITECTURE.md` to a PNG or PDF for Devpost.
- [ ] Record and upload the approximately three-minute demo video.
- [ ] Add the Slack developer sandbox URL to the submission.
- [ ] Invite `slackhack@salesforce.com` and `testing@devpost.com` and verify access.
- [ ] Paste the final project description from `SUBMISSION_NOTES.md` into Devpost.
- [ ] Select the **New Slack Agent** track unless the app is submitted to Slack Marketplace and satisfies the Organizations-track requirements.

## GitHub presentation

The pasted hackathon rules do not require a GitHub repository or polished commit history. The repository still supports the technological-implementation score, so make the landing page judge-friendly:

- [x] Put the problem, one-line value proposition, features, multi-source behavior, privacy model, and quick start in `README.md`.
- [x] Document source targeting and cross-provider synthesis in `MULTI_SOURCE_CAPABILITIES.md`.
- [x] Show source localization, evidence normalization, validation, and private setup in `ARCHITECTURE.md`.
- [x] Document `/connect`, dynamic OAuth services, and remote MCP behavior in `CONNECTORS.md`.
- [ ] Add one strong screenshot or short GIF of the cited Slack answer near the top of the README.
- [ ] Add a rendered architecture PNG and link it from the README; Devpost should not depend on Mermaid rendering.
- [ ] Add a short “Try the demo” section with the exact primary prompt and expected result.
- [ ] Add a concise limitations section that does not overclaim Discord or universal provider support.
- [ ] Confirm the license, installation steps, environment-variable names, and deployment instructions are accurate.
- [ ] Add the demo video link and Devpost link after they exist.

Do not spend deadline time rewriting or squashing harmless commit messages. Remove secrets and accidentally committed large/generated files; otherwise a goofy history is fine.

## Final 30-minute preflight

- [ ] Run `npm run check` from a clean working tree.
- [ ] Run `npm audit --omit=dev --audit-level=high`.
- [ ] Confirm `/health` returns success on the deployed origin.
- [ ] Confirm the manifest’s three public URLs resolve without redirects to a private or temporary host.
- [ ] Confirm source links in the recorded result are readable and relevant.
- [ ] Confirm `connectors` and all setup/authorization responses are private.
- [ ] Confirm a duplicate Slack delivery does not create a duplicate investigation.
- [ ] Confirm logs and the recording contain no tokens, secrets, credentials, or `.env` content.
- [ ] Open the submitted video and sandbox URL in a logged-out/incognito browser where possible.
