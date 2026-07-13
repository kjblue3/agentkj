# Submission readiness checklist

## Repository checks

- [x] Runtime integrations are provider-neutral; no bundled evidence, seeded provider data, or local fallback remains.
- [x] `/connect` is the only slash command in `manifest.json`.
- [x] Direct messages and app mentions enter the same investigation flow.
- [x] Personal, named-member, and workspace-wide connection scopes are distinct and tested.
- [x] Mutation requests are rejected and report UI does not imply write capability.
- [x] Request, interactivity, and OAuth placeholder URLs were removed from the Socket Mode manifest.
- [ ] Run `npm run check` from the final working tree.
- [ ] Run `npm audit --omit=dev --audit-level=high`.

## Deployment and Slack checks

- [ ] Decide whether the existing Slack app will retain `assistant_view`; rehearse the one-way `agent_view` migration before changing the manifest.
- [ ] If multi-workspace Slack OAuth is enabled, add the deployed HTTPS redirect origin to the installed Slack app configuration.
- [ ] Set and verify all durable variables documented in `.env.example` and `deploy/oci/slack-detective.env.example`.
- [ ] Confirm `/health` succeeds on the deployed origin.
- [ ] Confirm `/connect` responds privately in both a channel and a direct message.
- [ ] Confirm a direct message is treated as a prompt without an app mention.
- [ ] Rehearse personal, named-member, and workspace-wide questions using two real user grants; verify the tool calls never cross the requested owner scope.
- [ ] Confirm duplicate Slack delivery does not create a duplicate investigation.
- [ ] Confirm logs and recordings contain no tokens, credentials, `.env` content, or external account identifiers.

## Submission assets

- [ ] Export the architecture diagram to PNG or PDF.
- [ ] Add a strong cited-answer screenshot near the top of the README.
- [ ] Record and upload the product walkthrough video.
- [ ] Add the Slack developer sandbox URL and verify it from a logged-out browser where possible.
- [ ] Invite `slackhack@salesforce.com` and `testing@devpost.com`, then verify access.
- [ ] Paste the final description from `SUBMISSION_NOTES.md` into the submission form.
- [ ] Add the final video and submission links after they exist.
- [ ] Select the New Slack Agent track unless the app meets the marketplace requirements for another track.
