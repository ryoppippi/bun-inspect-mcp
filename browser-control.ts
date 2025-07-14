/**
 * Browser Control Script for Bun Inspector MCP
 * This script enables remote browser control via WebSocket using birpc
 * Load this script in any webpage to allow MCP server to control browser elements
 */

import type { 
  BrowserSelector, 
  ElementInfo, 
  ClickOptions, 
  EvaluateResult, 
  GetElementsResult, 
  WaitForElementResult, 
  PageInfo,
  BrowserFunctions,
  ServerFunctions,
  NotifyEventData
} from './browser-types';

// Type for birpc when loaded from CDN
type BirpcReturn<Remote> = Remote & {
  $functions: BrowserFunctions;
};

type CreateBirpc = <Remote = ServerFunctions>(
  functions: BrowserFunctions,
  options: {
    post: (data: any) => void;
    on: (handler: (data: any) => void) => void;
    serialize?: (data: any) => any;
    deserialize?: (data: any) => any;
  }
) => BirpcReturn<Remote>;

declare global {
  interface Window {
    BunInspectorMCP: {
      isConnected: () => boolean;
      disconnect: () => void;
      reconnect: () => void;
      browserFunctions: BrowserFunctions;
    };
  }
}

(async function() {
  // Load birpc from esm.sh
  // @ts-expect-error - dynamic import from CDN
  const birpcModule = await import('https://esm.sh/birpc@0.2.19') as { createBirpc: CreateBirpc };
  const { createBirpc } = birpcModule;
  
  // Configuration - check for data-ws-url attribute on script tag
  const scriptTag = document.currentScript || document.querySelector('script[src*="browser-control"]');
  const WS_URL = scriptTag?.dataset?.wsUrl || scriptTag?.getAttribute('data-ws-url') || 'ws://localhost:4000/_ws_browser';
  const RECONNECT_DELAY = 3000;
  
  console.log(`[BunInspectorMCP] Using WebSocket URL: ${WS_URL}`);
  
  // State
  let ws: WebSocket | null = null;
  let rpc: BirpcReturn<ServerFunctions> | null = null;
  let isConnected = false;
  
  // Helper function to find element (internal use)
  async function findElementInternal(params: BrowserSelector): Promise<Element> {
    let element: Element | null = null;
    
    switch (params.type) {
      case 'id':
        element = document.getElementById(params.value);
        break;
        
      case 'text':
        const elements = document.querySelectorAll(params.tagName || '*');
        for (const el of Array.from(elements)) {
          if (el.textContent && el.textContent.trim() === params.value) {
            element = el;
            break;
          }
        }
        break;
        
      case 'css':
        element = document.querySelector(params.value);
        break;
        
      case 'xpath':
        const result = document.evaluate(params.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        element = result.singleNodeValue as Element;
        break;
    }
    
    if (!element) {
      throw new Error(`Element not found: ${params.type}="${params.value}"${params.tagName ? ` tagName="${params.tagName}"` : ''}`);
    }
    
    return element;
  }
  
  // Browser functions exposed to MCP server
  const browserFunctions: BrowserFunctions = {
    // Find element by various selectors
    findElement: async (params: BrowserSelector): Promise<ElementInfo> => {
      const element = await findElementInternal(params);
      
      // Return element info
      return {
        found: true,
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        textContent: element.textContent?.trim().substring(0, 100),
        attributes: Array.from(element.attributes).reduce<Record<string, string>>((acc, attr) => {
          acc[attr.name] = attr.value;
          return acc;
        }, {}),
        rect: element.getBoundingClientRect() as DOMRect,
      };
    },
    
    // Click an element
    clickElement: async (params: BrowserSelector & { options?: ClickOptions }) => {
      const element = await findElementInternal(params);
      
      if (element instanceof HTMLElement) {
        element.click();
      } else {
        // Fallback for non-HTMLElements
        const event = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: params.options?.button === 'right' ? 2 : params.options?.button === 'middle' ? 1 : 0,
          clientX: params.options?.x,
          clientY: params.options?.y,
          ctrlKey: params.options?.modifiers?.ctrlKey,
          shiftKey: params.options?.modifiers?.shiftKey,
          altKey: params.options?.modifiers?.altKey,
          metaKey: params.options?.modifiers?.metaKey,
        });
        element.dispatchEvent(event);
      }
      
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
    inputText: async (params: BrowserSelector & { text: string; clear?: boolean }) => {
      const element = await findElementInternal(params);
      
      if (!['INPUT', 'TEXTAREA'].includes(element.tagName) && !(element as HTMLElement).isContentEditable) {
        throw new Error('Element is not an input field');
      }
      
      // Focus the element
      (element as HTMLElement).focus();
      
      // Set the value directly
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        const inputElement = element as HTMLInputElement | HTMLTextAreaElement;
        if (params.clear ?? true) {
          inputElement.value = params.text;
        } else {
          inputElement.value += params.text;
        }
        
        // Trigger input and change events
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        inputElement.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // For contenteditable
        if (params.clear ?? true) {
          element.textContent = params.text;
        } else {
          element.textContent += params.text;
        }
        
        // Trigger input event for contenteditable
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      return {
        success: true,
        element: {
          tagName: element.tagName,
          id: element.id,
          value: (element as HTMLInputElement).value || element.textContent || undefined
        }
      };
    },
    
    // Evaluate JavaScript in browser context
    evaluate: async ({ expression }: { expression: string }): Promise<EvaluateResult> => {
      try {
        // Use Function constructor instead of eval for slightly better security
        const result = new Function('return ' + expression)();
        return {
          success: true,
          result: result,
          type: typeof result
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        };
      }
    },
    
    // Get elements by selector
    getElements: async ({ selector, limit = 10 }: { selector: string; limit?: number }): Promise<GetElementsResult> => {
      const elements = document.querySelectorAll(selector);
      const results: Array<Omit<ElementInfo, 'found'>> = [];
      
      for (let i = 0; i < Math.min(elements.length, limit); i++) {
        const el = elements[i];
        if (!el) continue;
        results.push({
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          textContent: el.textContent?.trim().substring(0, 100),
          attributes: Array.from(el.attributes).reduce<Record<string, string>>((acc, attr) => {
            acc[attr.name] = attr.value;
            return acc;
          }, {}),
          rect: el.getBoundingClientRect() as DOMRect,
        });
      }
      
      return {
        count: elements.length,
        elements: results
      };
    },
    
    // Wait for element to appear
    waitForElement: async (params: BrowserSelector & { timeout?: number }): Promise<WaitForElementResult> => {
      const timeout = params.timeout ?? 5000;
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeout) {
        try {
          const element = await findElementInternal(params);
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
      
      throw new Error(`Element not found after ${timeout}ms: ${params.type}="${params.value}"`);
    },
    
    // Get page info
    getPageInfo: async (): Promise<PageInfo> => {
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
  
  // Connect to WebSocket server
  function connect() {
    console.log('[BunInspectorMCP] Connecting to WebSocket server...');
    
    ws = new WebSocket(WS_URL);
    
    ws.addEventListener('open', () => {
      console.log('[BunInspectorMCP] Connected to MCP server');
      isConnected = true;
      
      // Create birpc instance
      // Browser exposes browserFunctions, and gets back an rpc object to call serverFunctions
      rpc = createBirpc<ServerFunctions>(browserFunctions, {
        post: (data) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          } else {
            console.error('[BunInspectorMCP] WebSocket not open, state:', ws?.readyState);
          }
        },
        on: (handler) => {
          ws!.addEventListener('message', (event) => {
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