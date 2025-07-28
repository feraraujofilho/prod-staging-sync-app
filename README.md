# Production-Staging Sync App

A Shopify app that synchronizes metaobject and metafield definitions between production and staging stores. This app helps maintain consistency across environments during development and testing.

## Features

- **Store Connection Management**: Connect multiple production stores to sync from
- **Metaobject Definition Sync**: Sync custom metaobject schemas between stores
- **Metafield Definition Sync**: Sync product metafield definitions between stores
- **Theme Image Sync**: Sync images uploaded via theme editor (excludes product images)
- **Secure Token Storage**: Encrypted storage of Shopify access tokens
- **Detailed Sync Logs**: Track sync operations with comprehensive logging

## Prerequisites

1. **Node.js**: v18.20 or higher
2. **Shopify Partner Account**: [Create an account](https://partners.shopify.com/signup)
3. **Development Store**: For testing the app
4. **Shopify CLI**: Latest version for local development

## Setup

### 1. Install Dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```bash
# CRITICAL: Generate a persistent encryption key for secure token storage
ENCRYPTION_KEY=your-32-byte-hex-key-here
```

To generate a secure encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**⚠️ Important**: Keep this key safe and consistent. Changing it will invalidate all stored tokens.

### 3. Database Setup

Initialize the Prisma database:

```bash
npm run setup
# or
yarn setup
# or
pnpm setup
```

### 4. Start Development

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

### 5. Access Prisma Studio (Optional)

For database management and debugging during development, you can use Prisma Studio:

```bash
# Open a new terminal in the app-staging directory
cd app-staging
npm run studio
# or
npx prisma studio
```

This will open Prisma Studio at `http://localhost:5555` where you can:

- View and edit store connections
- Inspect session data
- Debug sync logs
- Manage database records directly

**Note**: Prisma Studio is particularly useful for managing authentication sessions during development.

## Usage

### 1. Store Connections

Navigate to **Settings** in the app to manage store connections:

1. Click "Add Store Connection"
2. Enter the production store details:
   - Store Name (for identification)
   - Store Domain (e.g., `my-store.myshopify.com`)
   - Access Token (from the production store's custom app)
3. Save the connection

### 2. Syncing Data

Navigate to **Sync** to synchronize definitions:

1. Select a store connection
2. Choose sync type:
   - **Metaobject Definitions**: Syncs custom metaobject schemas
   - **Metafield Definitions**: Syncs product metafield definitions
3. Click "Sync" and monitor progress
4. View detailed logs for each sync operation

## Current Limitations

### Metaobject Sync Limitations

1. **Reserved Metaobjects**: Cannot sync Shopify-reserved metaobjects (prefixed with `shopify--`)
   - These are system-managed and cannot be created by apps

2. **Cross-References**: Metaobjects that reference other metaobjects require special handling
   - The app uses a two-pass sync strategy:
     - First pass: Creates base metaobject definitions without references
     - Second pass: Updates definitions to add references with correct staging GIDs

3. **Global ID Mismatches**: Shopify uses different Global IDs (GIDs) between environments
   - References must be remapped during sync
   - The app automatically handles this for most cases

### Metafield Sync Limitations

1. **Shopify Namespace**: Cannot create metafields in the `shopify.` namespace
   - These are reserved for Shopify's internal use
   - Examples: `shopify.fabric`, `shopify.color-pattern`

2. **Metaobject Reference Fields**: Metafields that reference metaobjects have special requirements
   - These fields MUST have a validation specifying which metaobject they reference
   - Fields like `custom.brand` (type: `metaobject_reference`) require the referenced metaobject to exist first
   - Currently, these fields are skipped during sync

3. **Missing Scope**: The app needs appropriate scopes to create metafields
   - Metafield creation is based on namespace permissions, not a specific scope

### Theme Image Sync Limitations

1. **Theme Images Only**: Only syncs images uploaded via theme editor
   - Product images are excluded from sync
   - Only images in the Files section are synced

2. **Filename Preservation**: Files are synced with their original filenames
   - If a file with the same name exists, it will be skipped
   - No automatic renaming or versioning

3. **No ID Preservation**: Cannot preserve Shopify file IDs between environments
   - File references in themes may need manual updates
   - URLs will be different between production and staging

### General Limitations

1. **One-Way Sync**: Only syncs from production to staging (not bidirectional)
2. **Definition Only**: Syncs schemas/definitions, not actual data/values
3. **Manual Process**: No automatic sync scheduling or webhooks

## Error Messages and Solutions

### "Decryption error"

- **Cause**: The encryption key has changed or is missing
- **Solution**: Ensure `ENCRYPTION_KEY` is set in `.env` and hasn't changed

### "Unique constraint failed"

- **Cause**: Trying to create a duplicate store connection
- **Solution**: The app will automatically update existing connections

### "Not authorized" (Metaobjects)

- **Cause**: Trying to sync Shopify-reserved metaobjects
- **Solution**: These are automatically filtered out

### "Access denied" (Metafields)

- **Cause**: Trying to create metafields in the `shopify.` namespace
- **Solution**: These fields are system-managed and will be skipped

### "Validations require that you select a metaobject"

- **Cause**: Metaobject reference fields require validation
- **Solution**: These fields need manual creation with proper metaobject references

## Architecture

### Two-Pass Sync Strategy

To handle dependencies between metaobjects and metafields:

1. **First Pass**: Creates base definitions without cross-references
2. **Second Pass**: Updates definitions with proper references using staging GIDs

This ensures all dependencies exist before creating references.

### Security

- Access tokens are encrypted using AES-256-CBC encryption
- Tokens are never exposed in logs or UI
- Each token is encrypted with a unique IV for additional security

## Troubleshooting

### Authentication issues

If you're having trouble with app authentication during development:

1. Open Prisma Studio: `cd app-staging && npm run studio`
2. Check the `Session` table for your current session
3. Verify the session hasn't expired
4. If needed, delete old sessions and re-authenticate

### Sync shows many skipped items

This is normal behavior. The app skips:

- Shopify-reserved namespaces
- Fields requiring metaobject validations
- App-owned namespaces from other apps

### Metaobject references not working

Currently, metafield definitions that reference metaobjects must be created manually with the correct validation pointing to the staging metaobject GID.

### Database errors

Run the Prisma migration:

```bash
npx prisma migrate dev
```

### Prisma Studio not finding schema

If you see "Could not find Prisma Schema" error, ensure you're in the correct directory:

```bash
cd app-staging
npm run studio
```

The Prisma schema is located at `app-staging/prisma/schema.prisma`.

## Development

### Project Structure

```
app-staging/
├── app/
│   ├── routes/           # Remix routes
│   ├── services/         # Sync logic
│   ├── utils/           # Encryption utilities
│   └── shopify.server.js # Shopify app configuration
├── prisma/              # Database schema
└── shopify.app.toml     # App configuration
```

### Key Files

- `app/services/sync.metaobjects.server.js` - Metaobject sync logic
- `app/services/sync.metafields.server.js` - Metafield sync logic
- `app/services/sync.files.server.js` - Theme image sync logic
- `app/utils/encryption.server.js` - Token encryption/decryption
- `app/routes/app.sync.jsx` - Sync UI and actions
- `app/routes/app.settings.jsx` - Store connection management

### Development Tools

#### Prisma Studio

During development, you can use Prisma Studio to inspect and manage your database:

```bash
cd app-staging
npm run studio
# or
npx prisma studio
```

This is helpful for:

- Debugging authentication issues
- Manually managing store connections
- Viewing sync logs in detail
- Clearing test data

#### Running Multiple Services

For a complete development environment, you may want to run:

1. **Terminal 1**: `npm run dev` - Runs the Shopify app
2. **Terminal 2**: `npx prisma studio` - Database management interface

## Deployment

Follow the standard [Shopify app deployment guide](https://shopify.dev/docs/apps/deployment/web) with these additional considerations:

1. Set `NODE_ENV=production`
2. Set `ENCRYPTION_KEY` environment variable (use the same key as development)
3. Use a persistent database (not SQLite) for production

## Future Enhancements

1. **Dependency Resolution**: Automatically handle metaobject reference fields
2. **Bidirectional Sync**: Support syncing from staging back to production
3. **Scheduled Sync**: Automated sync on a schedule
4. **Selective Sync**: Choose specific definitions to sync
5. **Data Migration**: Sync actual metafield/metaobject values, not just definitions

## Resources

- [Shopify Metaobjects Documentation](https://shopify.dev/docs/apps/build/custom-data/metaobjects)
- [Shopify Metafields Documentation](https://shopify.dev/docs/apps/build/custom-data/metafields)
- [Shopify App Development](https://shopify.dev/docs/apps)
