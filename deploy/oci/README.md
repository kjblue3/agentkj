# Free Oracle Cloud deployment

This deployment runs one canonical Slack Detective process on an Oracle Cloud Always Free Ampere
A1 VM. Slack stays in Socket Mode, while Caddy provides the public HTTPS address required by
GitHub OAuth and connector setup forms.

The installer targets **Ubuntu 24.04 on ARM64**. It installs Node.js 22 and Caddy, builds the app,
creates persistent state storage, and registers services that start after reboot and restart after
failure.

## 1. Create the Always Free VM

In the Oracle Cloud console:

1. Create one `VM.Standard.A1.Flex` instance in the account's home region.
2. Choose the Ubuntu 24.04 ARM64 image and an Always Free-eligible size no larger than the
   account's displayed allowance. One OCPU and 6 GB RAM is enough for the demo.
3. Use an Always Free-eligible standard boot volume and assign a public IPv4 address.
4. Add your SSH public key.
5. In the subnet security list or network security group, allow inbound TCP:
   - `22` from your own IP, for administration.
   - `80` and `443` from `0.0.0.0/0`, for HTTPS certificate issuance and the web routes.
6. Do **not** open port `3000`. The Node process binds to `127.0.0.1`; only Caddy can reach it.

Remain on resources marked **Always Free-eligible** and do not upgrade the account to a paid plan.
Oracle may temporarily lack A1 capacity in a region; retry later if instance creation reports that
capacity is unavailable.

## 2. Install the application

SSH into the VM as the image's `ubuntu` user, then clone this repository into `/opt`:

```bash
sudo install -d -o "$USER" -g "$(id -gn)" /opt/slack-detective
git clone <repository-url> /opt/slack-detective
cd /opt/slack-detective
sudo bash deploy/oci/install.sh /opt/slack-detective
```

The installer discovers the VM's public IP and assigns the free hostname
`<dashed-public-ip>.sslip.io`. It prints the resulting HTTPS URL and writes it to
`PUBLIC_BASE_URL`. Re-running the installer is safe: it rebuilds the app and service definitions
without replacing the existing secrets file, while updating `PUBLIC_BASE_URL` if the VM's public IP
has changed.

If OCI metadata discovery is unavailable, provide the hostname explicitly:

```bash
sudo PUBLIC_HOST=203-0-113-10.sslip.io \
  bash deploy/oci/install.sh /opt/slack-detective
```

## 3. Add secrets

Open the root-managed environment file:

```bash
sudoedit /etc/slack-detective.env
```

At minimum, fill in:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`
- `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` for the agentic path
- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `GITHUB_APP_SLUG` for per-user GitHub

The file is mode `0640`, owned by root and the service user's primary group. Never put these values
in the repository, Slack messages, or deployment logs.

Apply changes:

```bash
sudo systemctl restart slack-detective
```

In the GitHub App settings, set the callback URL to:

```text
https://<dashed-public-ip>.sslip.io/auth/github/callback
```

Use the exact `PUBLIC_BASE_URL` value from `/etc/slack-detective.env`. Slack itself needs no event
request URL because Socket Mode remains enabled.

Caddy exposes only `/health` and `/auth/*`. The unauthenticated demo and investigation API routes
remain private on localhost so an internet visitor cannot spend the configured model quota.

## 4. Verify the hosted bot

```bash
PUBLIC_BASE_URL="$(sudo sed -n 's/^PUBLIC_BASE_URL=//p' /etc/slack-detective.env)"
curl --fail "$PUBLIC_BASE_URL/health"
sudo systemctl status slack-detective caddy --no-pager
sudo journalctl -u slack-detective -n 100 --no-pager
```

Then complete these checks:

1. Run `/detective` or mention the app in Slack.
2. Complete one user's GitHub connection and confirm the callback returns to the hosted service.
3. Connect or approve a remote connector and note its connection ID.
4. Restart with `sudo systemctl restart slack-detective`.
5. Confirm the GitHub connection and remote connector metadata still exist.
6. Have both teammates use the bot from Slack while neither runs the app locally.

Bearer credentials for remote MCP servers and catalog connector credentials deliberately remain
in memory for this hackathon build, so those secrets must be entered again after a process restart.

## Operations

View live logs:

```bash
sudo journalctl -u slack-detective -f
```

Restart or stop the bot:

```bash
sudo systemctl restart slack-detective
sudo systemctl stop slack-detective
```

Update secrets:

```bash
sudoedit /etc/slack-detective.env
sudo systemctl restart slack-detective
```

Deploy the newest code:

```bash
cd /opt/slack-detective
git pull --ff-only
npm run check
sudo bash deploy/oci/install.sh /opt/slack-detective
```

Inspect persistent state:

```bash
sudo ls -la /var/lib/slack-detective
```

The important files are `userTokens.local.json` and `remoteConnections.local.json`. The system
service uses a restrictive umask, and the state directory is accessible only to the service user.
