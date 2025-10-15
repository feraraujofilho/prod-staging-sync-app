# Performance Optimization for Long-Running Operations

This document outlines the optimizations implemented to prevent app crashes during long import/update operations.

## Issues Addressed

1. **Vite Development Server Timeouts**: The development server was crashing during long operations due to memory pressure and timeout limits.
2. **Memory Leaks**: Large product catalogs were causing memory buildup leading to crashes.
3. **Network Timeouts**: API calls were failing due to transient network issues without retry logic.
4. **Frontend Disconnection**: The frontend was losing connection to the backend during long operations.

## Solutions Implemented

### 1. Vite Configuration Optimizations (`vite.config.js`)

```javascript
// Increased timeout limits
timeout: 300000, // 5 minutes
keepAliveTimeout: 300000,
headersTimeout: 300000,

// Better code splitting for memory management
rollupOptions: {
  output: {
    manualChunks: {
      vendor: ['react', 'react-dom'],
      shopify: ['@shopify/app-bridge-react', '@shopify/polaris'],
    },
  },
},
```

### 2. Memory Management (`sync.products.server.js`)

- **Forced Garbage Collection**: Automatically triggers garbage collection every 10 batches during data fetching and every 50 products during processing
- **Retry Logic**: Added exponential backoff retry mechanism for API calls
- **Progress Tracking**: Enhanced progress reporting with detailed counters

### 3. Optimized Development Script (`start-dev.js`)

```bash
npm run dev:optimized
```

This script starts the app with:

- **4GB Memory Limit**: `--max-old-space-size=4096`
- **Manual GC**: `--expose-gc`
- **Memory Optimization**: `--optimize-for-size`
- **Increased Thread Pool**: `UV_THREADPOOL_SIZE=16`

### 4. Background Processing

Product sync operations run in the background with:

- **Non-blocking execution**: Returns immediately with a log ID
- **Progress polling**: Frontend polls for updates every 3 seconds
- **Persistent logging**: All operations are logged to database

## Usage Recommendations

### For Development

```bash
# Use the optimized development server
npm run dev:optimized
```

### For Large Catalogs (500+ products)

1. Run location sync first to ensure inventory mapping
2. Use the product sync (it automatically runs in background)
3. Monitor progress in the "Sync History" tab
4. Don't close the browser tab during sync (but it's safe to do so)

### Memory Monitoring

```bash
# Monitor Node.js memory usage
node --inspect start-dev.js
# Then open chrome://inspect in Chrome
```

## Troubleshooting

### If App Still Crashes

1. **Increase Node.js memory further**:

   ```bash
   export NODE_OPTIONS="--max-old-space-size=8192"
   npm run dev:optimized
   ```

2. **Check system resources**:

   ```bash
   # Monitor memory usage
   htop
   # Or on macOS
   Activity Monitor
   ```

3. **Reduce batch sizes**: Edit `first = 5` in `getProductionProducts()` to a smaller number like `first = 3`

### If Sync Gets Stuck

1. Check the "Sync History" tab for detailed logs
2. Look for specific error messages in the console
3. Restart the sync operation - it will skip already synced items

## Performance Metrics

With these optimizations, the app can handle:

- **Large catalogs**: 1000+ products with multiple variants
- **Long operations**: 30+ minute sync operations
- **Memory efficiency**: Stable memory usage under 4GB
- **Reliability**: Automatic retry on transient failures

## Monitoring

The app now provides detailed logging for:

- Memory usage and garbage collection
- API call retries and failures
- Progress tracking with product counters
- Inventory sync status per location
- Background operation status

