// Test script for market metafields sync
import { syncMetafieldValues } from './app/services/sync.metafields.server.js';

// Mock test data
const mockMetafields = [
  {
    namespace: 'custom',
    key: 'test_field',
    value: 'test_value',
    type: 'single_line_text_field'
  },
  {
    namespace: 'marketing',
    key: 'campaign_id',
    value: 'CAMPAIGN_2024',
    type: 'single_line_text_field'
  }
];

// Test the function (you'll need actual staging admin client)
async function testMetafieldsSync() {
  try {
    console.log('Testing metafields sync...');
    
    // You would need to initialize your actual staging admin client here
    // const stagingAdmin = await authenticate.admin(request);
    
    // For now, just test the function signature
    console.log('✅ Function imported successfully');
    console.log('Mock metafields to sync:', mockMetafields);
    
    // Uncomment when you have staging admin client:
    // const result = await syncMetafieldValues(
    //   'gid://shopify/Market/123456', // Market ID
    //   'MARKET',
    //   mockMetafields,
    //   stagingAdmin
    // );
    // console.log('Sync result:', result);
    
  } catch (error) {
    console.error('Test failed:', error);
  }
}

testMetafieldsSync();