# Salesforce MCP Server

A production-quality **Model Context Protocol (MCP)** server for Salesforce CRM. Exposes 19 tools covering Leads, Contacts, Accounts, Opportunities, Cases, and arbitrary SOQL queries — letting AI assistants like Claude read and write your Salesforce data through a safe, typed interface.

## Features

- **19 tools** across 6 tool groups (Leads, Contacts, Accounts, Opportunities, Cases, SOQL)
- **OAuth 2.0** authentication with automatic token refresh
- **Circuit breaker** (5 failures → 60s open), exponential backoff retry
- **Rate limit awareness** via `Sforce-Limit-Info` header tracking
- **30s request timeouts** with AbortController
- **Structured JSON logging** on stderr (stdout reserved for MCP protocol)
- **Stdio + HTTP transports** — local use or remote deployment
- **Full TypeScript** with MCP SDK v1.26.0, Zod v3.25.0

## Prerequisites

1. **Salesforce Connected App** with OAuth 2.0 enabled:
   - Go to Setup → App Manager → New Connected App
   - Enable OAuth, select scopes: `api`, `refresh_token`
   - Note your Consumer Key (Client ID) and Consumer Secret
2. Your Salesforce **username** and **password + security token** (concatenate: `passwordSECURITYTOKEN`)
3. Your Salesforce **instance URL** (e.g. `https://mycompany.my.salesforce.com`)
4. Node.js 18+

## Installation

```bash
git clone https://github.com/BusyBee3333/salesforce-mcp-2026-complete.git
cd salesforce-mcp-2026-complete
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
SALESFORCE_CLIENT_ID=your_connected_app_consumer_key
SALESFORCE_CLIENT_SECRET=your_connected_app_consumer_secret
SALESFORCE_USERNAME=your_salesforce_username@example.com
SALESFORCE_PASSWORD=your_password_plus_security_token
SALESFORCE_INSTANCE_URL=https://yourinstance.salesforce.com

# Optional: use sandbox
# SALESFORCE_LOGIN_URL=https://test.salesforce.com

# Optional: enable HTTP transport
# MCP_TRANSPORT=http
# MCP_HTTP_PORT=3000
```

> **Note:** `SALESFORCE_PASSWORD` must be your password concatenated with your security token (no space). If your password is `mypass` and token is `ABC123`, set `mypassABC123`.

## Claude Desktop Configuration

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "node",
      "args": ["/path/to/salesforce-mcp-2026-complete/dist/index.js"],
      "env": {
        "SALESFORCE_CLIENT_ID": "your_client_id",
        "SALESFORCE_CLIENT_SECRET": "your_client_secret",
        "SALESFORCE_USERNAME": "your_username@example.com",
        "SALESFORCE_PASSWORD": "your_password_plus_token",
        "SALESFORCE_INSTANCE_URL": "https://yourinstance.salesforce.com"
      }
    }
  }
}
```

## Tools

### Health
| Tool | Description |
|------|-------------|
| `health_check` | Validate connectivity, OAuth token, and environment setup |

### Leads
| Tool | Description |
|------|-------------|
| `list_leads` | List leads with filters: status, owner, lead source. Sortable, paginated. |
| `get_lead` | Get full lead details by Salesforce ID |
| `create_lead` | Create a new lead (requires LastName, Company) |
| `update_lead` | Update lead fields or status |

### Contacts
| Tool | Description |
|------|-------------|
| `list_contacts` | List contacts with filters: account, email. Paginated. |
| `get_contact` | Get full contact details by ID |
| `create_contact` | Create a contact, optionally linked to an Account |
| `update_contact` | Update contact fields including address |

### Accounts
| Tool | Description |
|------|-------------|
| `list_accounts` | List accounts with filters: type, industry, owner |
| `get_account` | Get account details; optionally include related contacts and opportunities |
| `create_account` | Create a new account |

### Opportunities
| Tool | Description |
|------|-------------|
| `list_opportunities` | List deals by stage, account, owner, close date range |
| `get_opportunity` | Get full opportunity details |
| `create_opportunity` | Create opportunity (requires name, stage, close date) |
| `update_opportunity` | Update stage, amount, close date, probability |

### Cases
| Tool | Description |
|------|-------------|
| `list_cases` | List support cases by status, priority, account |
| `get_case` | Get case details by ID |
| `create_case` | Create a support case |

### SOQL
| Tool | Description |
|------|-------------|
| `run_soql` | Execute any read-only SOQL SELECT query. DML blocked. |

## Rate Limits

Salesforce API limits depend on your org edition:
- **Developer Edition**: 15,000 API calls/24h
- **Enterprise**: 1,000 × number of user licenses / 24h
- **Unlimited**: Higher allocations

This server tracks `Sforce-Limit-Info` headers and logs remaining API usage at `debug` level. The circuit breaker prevents runaway API consumption.

## API Documentation

- [Salesforce REST API Developer Guide](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/)
- [SOQL and SOSL Reference](https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/)
- [OAuth 2.0 for Connected Apps](https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm)

## Development

```bash
# Run in dev mode (no build needed)
npm run dev

# Build TypeScript
npm run build

# Run built server
npm start

# Run with HTTP transport
npm run start:http
```

## License

MIT
