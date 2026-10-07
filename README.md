# dbeaver-readonly-mcp

An MCP server that gives an MCP client (Claude Code, Claude Desktop and the like) **read-only** access to the databases you already have configured in DBeaver, without copying credentials anywhere else.

## How it works

- Reads host, port, user and password from DBeaver's configuration at startup.
- Only exposes the connections listed in `allowlist.json`, by their DBeaver name.
- Every query runs with `default_transaction_read_only=on`, inside `BEGIN READ ONLY` and ending in `ROLLBACK`, with a 15s timeout and a row limit.
- Accepts a single statement per call (extended protocol), so `COMMIT; DROP ...` is rejected.
- Uses your own database user: it sees exactly what you see in DBeaver.

Tools: `list_connections`, `query`, `list_tables` (with owner and whether you have `SELECT`) and `describe_table`.

PostgreSQL only for now. Other databases need a new driver.

## Requirements

- Node 20+.
- DBeaver with the password saved on the connection ("Save password"). Passwords kept in Secure Storage (the OS keychain) are not read.

DBeaver's configuration is looked up in:

| OS | Folder |
| --- | --- |
| macOS | `~/Library/DBeaverData/workspace6/General/.dbeaver` |
| Linux | `~/.local/share/DBeaverData/workspace6/General/.dbeaver` |
| Windows | `%APPDATA%\DBeaverData\workspace6\General\.dbeaver` |

For another workspace or project, set `DBEAVER_CONFIG_DIR`. To keep the allowlist elsewhere, set `DBEAVER_MCP_ALLOWLIST`.

## Installation

```bash
git clone https://github.com/HenriqueRicardoFigueira/dbeaver-readonly-mcp.git ~/.claude/mcp/dbeaver-readonly
cd ~/.claude/mcp/dbeaver-readonly
npm install
cp allowlist.example.json allowlist.json
claude mcp add --scope user dbeaver-readonly -- "$(which node)" ~/.claude/mcp/dbeaver-readonly/index.js
```

If your shell's default `node` is older than 20, pass the path to a Node 20+ binary to `claude mcp add`.

## allowlist.json

```json
{
  "connections": {
    "MY-LOCAL-POSTGRES": {},
    "MY-STAGING-POSTGRES": { "database": "my_db", "ssl": true },
    "MY-RDS-BEHIND-CUSTOM-DNS": {
      "caFile": "certs/rds-global-bundle.pem",
      "tlsServerName": "my-instance.abc123xyz.us-east-1.rds.amazonaws.com"
    }
  }
}
```

The key is the connection name in DBeaver. Every field is optional:

- `database`: overrides the connection's database, useful when it points to `postgres` and you work in another one.
- `ssl`: `true` for TLS verified against the system CAs. When absent, connects without TLS.
- `caFile`: PEM file with the CA that signs the server certificate, relative to this folder. Enables TLS.
- `tlsServerName`: name to check in the certificate when the connection host is an alias (CNAME) the certificate doesn't cover. Enables TLS.

There is no option to turn certificate verification off: if it fails, point `caFile` to the right CA.

### Amazon RDS

RDS certificates are signed by AWS's own CAs, which are not in the system trust store. `npm run fetch-rds-ca` downloads the official global bundle to `certs/rds-global-bundle.pem`.

If you connect through your own DNS name pointing to the instance, the certificate only covers the `*.rds.amazonaws.com` endpoint. Put that endpoint in `tlsServerName`. To find it:

```bash
dig +short my-db.my-company.com CNAME
```

## Caution

Be careful when allowing production databases: read-only mode prevents writes, but the returned data goes into the model's context.

## License

MIT. See [LICENSE](LICENSE).
