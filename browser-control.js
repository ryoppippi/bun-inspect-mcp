(() => {
  var __create = Object.create;
  var __getProtoOf = Object.getPrototypeOf;
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __toESM = (mod, isNodeMode, target) => {
    target = mod != null ? __create(__getProtoOf(mod)) : {};
    const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: () => mod[key],
          enumerable: true
        });
    return to;
  };
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined")
      return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // browser-control.ts
  (async function() {
    const birpcModule = await import("https://esm.sh/birpc@0.2.19");
    const { createBirpc } = birpcModule;
    const scriptTag = document.currentScript || document.querySelector('script[src*="browser-control"]');
    const WS_URL = scriptTag?.dataset?.wsUrl || scriptTag?.getAttribute("data-ws-url") || "ws://localhost:4000/_ws_browser";
    const RECONNECT_DELAY = 3000;
    console.log(`[BunInspectorMCP] Using WebSocket URL: ${WS_URL}`);
    let ws = null;
    let rpc = null;
    let isConnected = false;
    async function findElementInternal(params) {
      let element = null;
      switch (params.type) {
        case "id":
          element = document.getElementById(params.value);
          break;
        case "text":
          const elements = document.querySelectorAll(params.tagName || "*");
          for (const el of Array.from(elements)) {
            if (el.textContent && el.textContent.trim() === params.value) {
              element = el;
              break;
            }
          }
          break;
        case "css":
          element = document.querySelector(params.value);
          break;
        case "xpath":
          const result = document.evaluate(params.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          element = result.singleNodeValue;
          break;
      }
      if (!element) {
        throw new Error(`Element not found: ${params.type}="${params.value}"${params.tagName ? ` tagName="${params.tagName}"` : ""}`);
      }
      return element;
    }
    const browserFunctions = {
      findElement: async (params) => {
        const element = await findElementInternal(params);
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
          rect: element.getBoundingClientRect()
        };
      },
      clickElement: async (params) => {
        const element = await findElementInternal(params);
        if (element instanceof HTMLElement) {
          element.click();
        } else {
          const event = new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: params.options?.button === "right" ? 2 : params.options?.button === "middle" ? 1 : 0,
            clientX: params.options?.x,
            clientY: params.options?.y,
            ctrlKey: params.options?.modifiers?.ctrlKey,
            shiftKey: params.options?.modifiers?.shiftKey,
            altKey: params.options?.modifiers?.altKey,
            metaKey: params.options?.modifiers?.metaKey
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
      inputText: async (params) => {
        const element = await findElementInternal(params);
        if (!["INPUT", "TEXTAREA"].includes(element.tagName) && !element.isContentEditable) {
          throw new Error("Element is not an input field");
        }
        element.focus();
        if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
          const inputElement = element;
          if (params.clear ?? true) {
            inputElement.value = params.text;
          } else {
            inputElement.value += params.text;
          }
          inputElement.dispatchEvent(new Event("input", { bubbles: true }));
          inputElement.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          if (params.clear ?? true) {
            element.textContent = params.text;
          } else {
            element.textContent += params.text;
          }
          element.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return {
          success: true,
          element: {
            tagName: element.tagName,
            id: element.id,
            value: element.value || element.textContent || undefined
          }
        };
      },
      evaluate: async ({ expression }) => {
        try {
          const result = new Function("return " + expression)();
          return {
            success: true,
            result,
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
      getElements: async ({ selector, limit = 10 }) => {
        const elements = document.querySelectorAll(selector);
        const results = [];
        for (let i = 0;i < Math.min(elements.length, limit); i++) {
          const el = elements[i];
          if (!el)
            continue;
          results.push({
            tagName: el.tagName,
            id: el.id,
            className: el.className,
            textContent: el.textContent?.trim().substring(0, 100),
            attributes: Array.from(el.attributes).reduce((acc, attr) => {
              acc[attr.name] = attr.value;
              return acc;
            }, {}),
            rect: el.getBoundingClientRect()
          });
        }
        return {
          count: elements.length,
          elements: results
        };
      },
      waitForElement: async (params) => {
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
          } catch (e) {}
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Element not found after ${timeout}ms: ${params.type}="${params.value}"`);
      },
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
    function connect() {
      console.log("[BunInspectorMCP] Connecting to WebSocket server...");
      ws = new WebSocket(WS_URL);
      ws.addEventListener("open", () => {
        console.log("[BunInspectorMCP] Connected to MCP server");
        isConnected = true;
        rpc = createBirpc(browserFunctions, {
          post: (data) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(data);
            } else {
              console.error("[BunInspectorMCP] WebSocket not open, state:", ws?.readyState);
            }
          },
          on: (handler) => {
            ws.addEventListener("message", (event) => {
              handler(event.data);
            });
          },
          serialize: (data) => JSON.stringify(data),
          deserialize: (data) => JSON.parse(data)
        });
        if (rpc.notifyEvent) {
          rpc.notifyEvent({
            type: "connected",
            data: {
              url: window.location.href,
              userAgent: navigator.userAgent
            }
          }).then(() => {
            console.log("[BunInspectorMCP] Successfully notified server of connection");
          }).catch((error) => {
            console.error("[BunInspectorMCP] Failed to notify server:", error);
          });
        }
      });
      ws.addEventListener("close", () => {
        console.log("[BunInspectorMCP] Disconnected from MCP server");
        isConnected = false;
        rpc = null;
        setTimeout(connect, RECONNECT_DELAY);
      });
      ws.addEventListener("error", (error) => {
        console.error("[BunInspectorMCP] WebSocket error:", error);
      });
    }
    connect();
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
      browserFunctions
    };
    console.log("[BunInspectorMCP] Browser control script loaded. Connecting to MCP server...");
  })();
})();
