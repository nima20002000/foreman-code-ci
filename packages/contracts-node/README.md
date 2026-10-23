# Node contracts runtime

Node-only helpers shared by the API, CI service, Worker, and local development tooling.
Schemas and browser-safe domain types stay in `@foreman-code/contracts`. CI tooling stays there too.

Build after contracts and before CI or API. Import helpers through the exported subpaths:
`server-kit`, `installed-runtime-node`, `local-client-node`, `device-identity-node`,
`device-setup-node`, and `device-tls-node`.
