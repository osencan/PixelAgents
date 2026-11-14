# Security Policy

## Supported Versions

| Version | Supported                                                                  |
| ------- | -------------------------------------------------------------------------- |
| 2.x.x   | :white_check_mark:                                                         |
| 1.x.x   | Not here: report to [the original project](https://github.com/pixel-agents-hq/pixel-agents) |

## Reporting a Vulnerability

Please report security vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/osencan/PixelAgents/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

We will acknowledge your report within 7 days and aim to release a fix within 30 days of confirmation.

## Scope

Security issues relevant to this project include:

- Command injection via terminal spawning or JSONL parsing
- Arbitrary file read/write beyond intended paths
- Cross-site scripting (XSS) in the webview
- Sensitive data exposure (e.g., leaking terminal output or session content)
- Agent controls: approving a permission request, launching an agent or reaching a terminal without the token plus control (this machine or a PIN unlock)
- Read-only viewers seeing more than activity categories (file names, commands, prompt text)
