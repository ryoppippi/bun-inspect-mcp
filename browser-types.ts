// Shared types for browser control functionality

export interface BrowserSelector {
  type: 'id' | 'text' | 'css' | 'xpath';
  value: string;
  tagName?: string;
}

export interface ElementInfo {
  found?: boolean;
  tagName: string;
  id: string;
  className: string;
  textContent?: string;
  attributes: Record<string, string>;
  rect: DOMRect;
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  x?: number;
  y?: number;
  modifiers?: {
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  };
}

export interface EvaluateResult {
  success: boolean;
  result?: any;
  type?: string;
  error?: string;
  stack?: string;
}

export interface GetElementsResult {
  count: number;
  elements: Array<Omit<ElementInfo, 'found'>>;
}

export interface WaitForElementResult {
  found: boolean;
  waited: number;
  element: {
    tagName: string;
    id: string;
    className: string;
  };
}

export interface PageInfo {
  url: string;
  title: string;
  readyState: DocumentReadyState;
  viewport: {
    width: number;
    height: number;
  };
  screen: {
    width: number;
    height: number;
  };
}

export interface NotifyEventData {
  type: string;
  data: any;
}

// Browser functions exposed to MCP server
export interface BrowserFunctions {
  findElement: (params: BrowserSelector) => Promise<ElementInfo>;
  clickElement: (params: BrowserSelector & { options?: ClickOptions }) => Promise<{
    success: boolean;
    element: {
      tagName: string;
      id: string;
      className: string;
    };
  }>;
  inputText: (params: BrowserSelector & { text: string; clear?: boolean }) => Promise<{
    success: boolean;
    element: {
      tagName: string;
      id: string;
      value?: string;
    };
  }>;
  evaluate: (params: { expression: string }) => Promise<EvaluateResult>;
  getElements: (params: { selector: string; limit?: number }) => Promise<GetElementsResult>;
  waitForElement: (params: BrowserSelector & { timeout?: number }) => Promise<WaitForElementResult>;
  getPageInfo: () => Promise<PageInfo>;
}

// Server functions that browser can call
export interface ServerFunctions {
  notifyEvent: (data: NotifyEventData) => Promise<void>;
  reportError: (error: any) => Promise<void>;
}

// Browser connection state
export interface BrowserConnection {
  id: string;
  ws: any;
  rpc: any;
  url: string;
  connected: boolean;
}