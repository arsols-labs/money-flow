# Changelog

All notable changes to the Money Flow app are documented here.

## 2.27.0 - 2026-10-28

### Added

- MCP widgets (Pulse, Analytics and the write confirmation) are localized in all seven supported languages and follow the language of the MCP host, falling back to the browser language and then English. Numbers and currencies are formatted for that language.

### Changed

- MCP tool descriptions, tool error messages, confirmation prompts and server-side errors are now in English. Surfaces without a language choice default to English.
- Default names for transfer operations created without an item are now English (`Transfer to "…"` / `Transfer from "…"`). Existing operations are not changed.

## 2.26.5 - 2026-10-28

### Changed

- Source comments and changelog wording cleaned up to English. No user-visible behavior changes.

## 2.26.4 - 2026-10-28

### Changed

- The OAuth consent page is now localized.
- The OAuth provider library was updated. When a client refreshes a token for a resource the server no longer serves, it now gets `invalid_grant` and must re-authorize, instead of `invalid_target`.
- Routine dependency updates for the app and its build tooling.

### Fixed

- OAuth grants are now recorded with an id derived from the authorization code, so each authorization is tracked reliably.

### Security

- Patched versions of `undici` and `zod` are now enforced in the build and test tooling, fixing known vulnerabilities in those packages.

## Known Limitations

- Consent CSRF tokens are stored in eventually consistent KV; a rare concurrent double-submit may fail and require retrying authorization.
- Clients may register private-use URI scheme redirect URIs (native app callbacks) alongside https or loopback ones, but authorization requests that use a private-use scheme redirect URI are rejected; use https or loopback redirect URIs.
