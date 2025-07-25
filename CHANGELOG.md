# Changelog

All notable changes to the Production-Staging Sync App will be documented in this file.

## [1.1.0] - 2025-07-25

### Added

- Two-pass sync strategy for metaobjects with dependencies
- Two-pass sync strategy for metafields with metaobject references
- Comprehensive README documentation
- Detailed skip reason tracking in sync summaries
- Better error messages for namespace restrictions
- Improved UI for sync log details modal

### Fixed

- Encryption key handling for consistent token storage
- UI display issues with JSON stringified data
- Store connection update logic (handles duplicates gracefully)
- Metaobject reference field creation during sync
- Proper filtering of Shopify-reserved namespaces

### Changed

- Enhanced sync logging with more descriptive messages
- Updated sync summary format to show skip reasons
- Improved error handling throughout the sync process

### Known Issues

- Metafields with metaobject references must be created manually
- Cannot sync Shopify-reserved namespaces (by design)
- No bidirectional sync support (production to staging only)

## [1.0.0] - Initial Release

### Features

- Store connection management with encrypted token storage
- Metaobject definition synchronization
- Metafield definition synchronization
- Detailed sync logs with timestamps
- Secure token encryption using AES-256-CBC

### Security

- Encrypted storage of Shopify access tokens
- Environment-based encryption key configuration
- No token exposure in logs or UI
