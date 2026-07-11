# OCI deployment

Install the service with `deploy/oci/install.sh`, then configure the environment file from `slack-detective.env.example`.

The public base URL serves generic OAuth callbacks and private setup forms. Persist `STATE_DB_PATH` on durable storage and keep `STATE_ENCRYPTION_KEY` stable across restarts. Restrict both environment and database files to the service account.

After deployment, verify `/health`, the Slack Socket Mode connection, one administrator setup flow, two member authorizations, a public threaded investigation, and restart recovery for a queued job.
