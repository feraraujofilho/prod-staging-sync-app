/**
 * Mock Shopify Admin API client for testing
 * Simulates stagingAdmin.graphql() with configurable responses
 */

/**
 * Create a mock Shopify admin client
 * @param {Array<Object>} responses - Queue of responses to return in order
 * @returns {Object} Mock admin client with graphql method and call tracking
 */
export function createMockAdmin(responses = []) {
  const calls = [];
  let responseIndex = 0;

  const admin = {
    graphql: async (query, options) => {
      const call = { query, variables: options?.variables };
      calls.push(call);

      const response = responses[responseIndex] || { data: {} };
      responseIndex++;

      return {
        json: async () => response,
      };
    },
    getCalls: () => calls,
    getLastCall: () => calls[calls.length - 1],
    reset: () => {
      calls.length = 0;
      responseIndex = 0;
    },
  };

  return admin;
}

/**
 * Create a mock fetch function for production store API calls
 * @param {Array<Object>} responses - Queue of responses to return
 * @returns {Function} Mock fetch function
 */
export function createMockFetch(responses = []) {
  let responseIndex = 0;
  const calls = [];

  const mockFetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });

    const response = responses[responseIndex] || { data: {} };
    responseIndex++;

    return {
      ok: true,
      json: async () => response,
    };
  };

  mockFetch.getCalls = () => calls;
  mockFetch.reset = () => {
    calls.length = 0;
    responseIndex = 0;
  };

  return mockFetch;
}
