---
title: CLI reference
description: The connect CLI — manage connectors, links, and tokens from the terminal.
sidebar:
  order: 2
---

The `connect` CLI (`packages/cli`) manages connectors and requests tokens. Configuration is persisted at `~/.config/connect/config.json` (mode 600).

## Authentication

```bash
connect login                 # paste a personal access token (cn_pat_…)
connect whoami                # show org, principal kind, and role
```

`login` accepts `--api-url <url>` (default: `CONNECT_API_URL` or `http://localhost:4000`), probes `/v1/me` with the pasted token, and saves the config on success.

## Commands

| Command | What it does | Options |
| --- | --- | --- |
| `connect login` | Authenticate with a PAT | `--api-url <url>` |
| `connect whoami` | Show the current identity | |
| `connect connectors list` | List connectors (slug, type, status, id) | |
| `connect connectors create` | Create a connector interactively (`api_key` or `oauth2`) | |
| `connect link <project> <connector>` | Link a connector to a project | `--env <envs>` (comma-separated, default `production`) |
| `connect authorize <connector>` | Start an OAuth authorization; prints the consent URL | `--user <userId>` |
| `connect installations <connector>` | List a connector's installations | |
| `connect token <connector>` | Request a short-lived provider token | `--scopes <csv>`, `--installation <id>`, `--user <userId>`, `--json` |
| `connect projects` | List projects | |

## Example session

```bash
connect login
connect connectors list
connect connectors create
connect link demo-app slack-main --env production,preview
connect authorize slack-main  # prints the consent URL
connect token slack-main --scopes chat:write
```

`connect token` prints the token to stdout and metadata to stderr, so it composes in scripts; pass `--json` for the full response.
