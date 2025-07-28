# Changelog

All notable changes to the Production-Staging Sync App will be documented in this file.

## [1.4.0] - 2025-07-25

### Added

- Page sync functionality
- Sync online store pages with content preservation
- Page reference handling in navigation menus
- Automatic page ID mapping for menu items
- `read_online_store_pages` and `write_online_store_pages` scopes

### Changed

- Enhanced navigation menu sync to handle page dependencies
- Updated documentation with page sync limitations
- Added page sync option to main sync interface

### Known Issues

- Page metafields are not currently synced (planned for future release)
- Menu items referencing pages require those pages to be synced first

## [1.3.0] - 2025-07-25

### Added

- Navigation menu sync functionality
- Sync navigation menus with nested structure (up to 3 levels)
- Support for menu updates vs creation
- `write_online_store_navigation` scope for menu management

### Changed

- Added `NavigationIcon` for navigation menu sync UI
- Updated documentation with navigation sync limitations

## [1.2.0] - 2025-07-25

### Added

- Theme image sync functionality
- Sync images uploaded via theme editor (excludes product images)
- Progress tracking for file sync operations
- Duplicate file detection and skipping
- `write_files` scope for file management
- Prisma Studio integration for development workflow

### Changed

- Added `ImageIcon` for theme image sync UI
- Updated documentation with file sync limitations

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
