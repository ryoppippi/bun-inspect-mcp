/**
 * Browser Control Script for Bun Inspector MCP
 * This script enables remote browser control via WebSocket using birpc
 * Load this script in any webpage to allow MCP server to control browser elements
 */

(async function() {
  // Load birpc from esm.sh
  const { createBirpc } = await import('https://esm.sh/birpc@0.2.19');
  
  // Configuration - check for data-ws-url attribute on script tag
  const scriptTag = document.currentScript || document.querySelector('script[src*="browser-control.js"]');
  const WS_URL = scriptTag?.dataset?.wsUrl || scriptTag?.getAttribute('data-ws-url') || 'ws://localhost:4000/_ws_browser';
  const RECONNECT_DELAY = 3000;
  
  console.log(`[BunInspectorMCP] Using WebSocket URL: ${WS_URL}`);
  
  // State
  let ws = null;
  let rpc = null;
  let isConnected = false;
  
  // Browser functions exposed to MCP server
  const browserFunctions = {
    // Find element by various selectors
    findElement: async ({ type, value, tagName }) => {
      let element = null;
      
      switch (type) {
        case 'id':
          element = document.getElementById(value);
          break;
          
        case 'text':
          // Find by text content
          const elements = document.querySelectorAll(tagName || '*');
          for (const el of elements) {
            if (el.textContent && el.textContent.trim() === value) {
              element = el;
              break;
            }
          }
          break;
          
        case 'css':
          element = document.querySelector(value);
          break;
          
        case 'xpath':
          const result = document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          element = result.singleNodeValue;
          break;
      }
      
      if (!element) {
        throw new Error(`Element not found: ${type}="${value}"${tagName ? ` tagName="${tagName}"` : ''}`);
      }
      
      // Return element info
      return {
        found: true,
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        textContent: element.textContent?.trim().substring(0, 100),
        attributes: Array.from(element.attributes).reduce((acc, attr) => {
          acc[attr.name] = attr.value;
          return acc;
        }, {}),
        rect: element.getBoundingClientRect(),
      };
    },
    
    // Click an element
    clickElement: async ({ type, value, tagName, options = {} }) => {
      const element = await findElementInternal({ type, value, tagName });
      
      element.click();
      
      return {
        success: true,
        element: {
          tagName: element.tagName,
          id: element.id,
          className: element.className
        }
      };
    },
    
    // Input text into an element
    inputText: async ({ type, value, tagName, text, clear = true }) => {
      const element = await findElementInternal({ type, value, tagName });
      
      if (!['INPUT', 'TEXTAREA'].includes(element.tagName) && !element.isContentEditable) {
        throw new Error('Element is not an input field');
      }
      
      // Focus the element
      element.focus();
      
      // Clear existing content if requested
      if (clear) {
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
          element.value = '';
        } else {
          element.textContent = '';
        }
      }
      
      // Input new text
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        element.value += text;
        
        // Trigger input event
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // For contenteditable
        element.textContent += text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      return {
        success: true,
        element: {
          tagName: element.tagName,
          id: element.id,
          value: element.value || element.textContent
        }
      };
    },
    
    // Evaluate JavaScript in browser context
    evaluate: async ({ expression }) => {
      try {
        const result = eval(expression);
        return {
          success: true,
          result: result,
          type: typeof result
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          stack: error.stack
        };
      }
    },
    
    // Get elements by selector
    getElements: async ({ selector, limit = 10 }) => {
      const elements = document.querySelectorAll(selector);
      const results = [];
      
      for (let i = 0; i < Math.min(elements.length, limit); i++) {
        const el = elements[i];
        results.push({
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          textContent: el.textContent?.trim().substring(0, 100),
          attributes: Array.from(el.attributes).reduce((acc, attr) => {
            acc[attr.name] = attr.value;
            return acc;
          }, {}),
          rect: el.getBoundingClientRect(),
        });
      }
      
      return {
        count: elements.length,
        elements: results
      };
    },
    
    // Wait for element to appear
    waitForElement: async ({ type, value, tagName, timeout = 5000 }) => {
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeout) {
        try {
          const element = await findElementInternal({ type, value, tagName });
          if (element) {
            return {
              found: true,
              waited: Date.now() - startTime,
              element: {
                tagName: element.tagName,
                id: element.id,
                className: element.className
              }
            };
          }
        } catch (e) {
          // Element not found yet, continue waiting
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      throw new Error(`Element not found after ${timeout}ms: ${type}="${value}"`);
    },
    
    // Get page info
    getPageInfo: async () => {
      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        screen: {
          width: screen.width,
          height: screen.height
        }
      };
    }
  };
  
  // Helper function to find element (internal use)
  async function findElementInternal({ type, value, tagName }) {
    let element = null;
    
    switch (type) {
      case 'id':
        element = document.getElementById(value);
        break;
        
      case 'text':
        const elements = document.querySelectorAll(tagName || '*');
        for (const el of elements) {
          if (el.textContent && el.textContent.trim() === value) {
            element = el;
            break;
          }
        }
        break;
        
      case 'css':
        element = document.querySelector(value);
        break;
        
      case 'xpath':
        const result = document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        element = result.singleNodeValue;
        break;
    }
    
    if (!element) {
      throw new Error(`Element not found: ${type}="${value}"${tagName ? ` tagName="${tagName}"` : ''}`);
    }
    
    return element;
  }
  
  // Server functions that browser can call (if needed)
  const serverFunctions = {
    // Browser can notify server of events
    notifyEvent: () => {},
    reportError: () => {},
  };
  
  // Connect to WebSocket server
  function connect() {
    console.log('[BunInspectorMCP] Connecting to WebSocket server...');
    
    ws = new WebSocket(WS_URL);
    
    ws.addEventListener('open', () => {
      console.log('[BunInspectorMCP] Connected to MCP server');
      isConnected = true;
      
      // Create birpc instance
      // Browser exposes browserFunctions, and gets back an rpc object to call serverFunctions
      rpc = createBirpc(browserFunctions, {
        post: (data) => {
          console.log('[BunInspectorMCP] Sending to server:', data);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          } else {
            console.error('[BunInspectorMCP] WebSocket not open, state:', ws.readyState);
          }
        },
        on: (handler) => {
          ws.addEventListener('message', (event) => {
            console.log('[BunInspectorMCP] Received from server:', event.data);
            handler(event.data);
          });
        },
        serialize: (data) => JSON.stringify(data),
        deserialize: (data) => JSON.parse(data),
      });
      
      // Notify server that browser is ready
      if (rpc.notifyEvent) {
        rpc.notifyEvent({
          type: 'connected',
          data: {
            url: window.location.href,
            userAgent: navigator.userAgent
          }
        }).then(() => {
          console.log('[BunInspectorMCP] Successfully notified server of connection');
        }).catch((error) => {
          console.error('[BunInspectorMCP] Failed to notify server:', error);
        });
      }
    });
    
    ws.addEventListener('close', () => {
      console.log('[BunInspectorMCP] Disconnected from MCP server');
      isConnected = false;
      rpc = null;
      
      // Attempt to reconnect
      setTimeout(connect, RECONNECT_DELAY);
    });
    
    ws.addEventListener('error', (error) => {
      console.error('[BunInspectorMCP] WebSocket error:', error);
    });
  }
  
  // Start connection
  connect();
  
  // Expose API to window for manual testing
  window.BunInspectorMCP = {
    isConnected: () => isConnected,
    disconnect: () => {
      if (ws) {
        ws.close();
        ws = null;
      }
    },
    reconnect: () => {
      if (ws) {
        ws.close();
      }
      connect();
    },
    // Allow manual testing of functions
    browserFunctions
  };
  
  console.log('[BunInspectorMCP] Browser control script loaded. Connecting to MCP server...');
})();
