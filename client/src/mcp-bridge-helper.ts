// Helper providing window.__MCP__.resolveRef for Tauri MCP Bridge automation

(function initMcpBridgeHelper() {
  if (globalThis.window === undefined) return;

  interface McpInterface {
    resolveRef?: (selectorOrRef?: string, strategy?: string) => Element | null;
    resolveAll?: (selector?: string, strategy?: string) => Element[];
    countAll?: (selector?: string, strategy?: string) => number;
    reverseRefs?: Map<string, Element>;
    isRendered?: (element: Element) => boolean;
    INTERACTIVE_SELECTOR?: string;
  }

  interface WindowWithMcp extends Window {
    __MCP__?: McpInterface;
    __MCP_INJECT_SCRIPTS__?: (scripts: Array<{ id?: string; type?: string; content?: string }>) => void;
  }

  // SAFETY: Window extension for Tauri MCP bridge automation
  const w = window as WindowWithMcp;

  w.__MCP__ = w.__MCP__ || {};

  const REF_PATTERN = /^\[?(?:ref=)?(e\d+)\]?$/;
  const NON_RENDERED_TAGS = {
    SCRIPT: 1,
    STYLE: 1,
    TITLE: 1,
    HEAD: 1,
    META: 1,
    LINK: 1,
    TEMPLATE: 1,
    NOSCRIPT: 1,
    BASE: 1,
  } as const;
  const INTERACTIVE_SELECTOR =
    'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[tabindex]';

  function isRendered(element: Element): boolean {
    if (!element || element.nodeType !== 1) return false;
    if (element.tagName in NON_RENDERED_TAGS) return false;
    // SAFETY: Checking hidden property on HTML element
    if ((element as HTMLElement).hidden) return false;
    if (element.getClientRects().length === 0) return false;
    try {
      const style = window.getComputedStyle(element);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    } catch {
      return false;
    }
    return true;
  }

  function hasMatchingDescendant(element: Element, needle: string): boolean {
    const descendants = element.querySelectorAll('*');
    for (let i = 0; i < descendants.length; i++) {
      const el = descendants[i];
      if (!isRendered(el)) continue;
      const content = (el.textContent || '').trim();
      if (content.indexOf(needle) !== -1) return true;
    }
    return false;
  }

  function preferInteractive(el: Element): Element {
    if (el.matches(INTERACTIVE_SELECTOR)) return el;
    const host = el.closest(INTERACTIVE_SELECTOR);
    return host && isRendered(host) ? host : el;
  }

  function dedupe(arr: Element[]): Element[] {
    const seen = new Set<Element>();
    const result: Element[] = [];
    for (const el of arr) {
      if (!seen.has(el)) {
        seen.add(el);
        result.push(el);
      }
    }
    return result;
  }

  function textCandidates(needle: string): Element[] {
    const all = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
    const exact: Element[] = [];
    const partial: Element[] = [];

    for (const el of all) {
      const content = (el.textContent || '').trim();
      // SAFETY: Filtered boolean values leaving only valid string attribute values
      const attributeText = [
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
      ].filter(Boolean) as string[];
      const exactAttribute = attributeText.indexOf(needle) !== -1;
      const partialAttribute = attributeText.some((val) => val.indexOf(needle) !== -1);
      const textMatch = content.indexOf(needle) !== -1;

      if (!textMatch && !partialAttribute) continue;
      if (!isRendered(el)) continue;
      if (textMatch && el.querySelector('*') && hasMatchingDescendant(el, needle)) continue;
      (content === needle || exactAttribute ? exact : partial).push(preferInteractive(el));
    }

    return dedupe(exact.length > 0 ? exact : partial);
  }

  w.__MCP__.resolveRef = function (selectorOrRef?: string, strategy?: string): Element | null {
    if (!selectorOrRef) return null;

    const refMatch = selectorOrRef.match(REF_PATTERN);
    if (refMatch) {
      const reverseRefs = w.__MCP__?.reverseRefs;
      if (!reverseRefs) {
        throw new Error('Ref IDs require a snapshot. Run webview_dom_snapshot first to index elements.');
      }
      return reverseRefs.get(refMatch[1]) || null;
    }

    if (strategy === 'text') {
      const candidates = textCandidates(selectorOrRef);
      return candidates[0] || null;
    }

    if (strategy === 'xpath') {
      const result = document.evaluate(
        selectorOrRef,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      // SAFETY: XPath node value cast to DOM Element
      const node = result.singleNodeValue as Element | null;
      return node && isRendered(node) ? node : null;
    }

    return document.querySelector(selectorOrRef);
  };

  w.__MCP__.resolveAll = function (selector?: string, strategy?: string): Element[] {
    if (!selector) return [];

    const refMatch = selector.match(REF_PATTERN);
    if (refMatch) {
      const el = w.__MCP__?.resolveRef?.(selector);
      return el ? [el] : [];
    }

    if (strategy === 'text') {
      return textCandidates(selector);
    }

    if (strategy === 'xpath') {
      const snapshot = document.evaluate(
        selector,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      const results: Element[] = [];
      for (let i = 0; i < snapshot.snapshotLength; i++) {
        // SAFETY: XPath snapshot item cast to DOM Element
        const node = snapshot.snapshotItem(i) as Element | null;
        if (node && isRendered(node)) results.push(node);
      }
      return results;
    }

    return Array.from(document.querySelectorAll(selector));
  };

  w.__MCP__.countAll = function (selector?: string, strategy?: string): number {
    return w.__MCP__?.resolveAll?.(selector, strategy).length || 0;
  };

  w.__MCP__.isRendered = isRendered;
  w.__MCP__.INTERACTIVE_SELECTOR = INTERACTIVE_SELECTOR;

  w.__MCP_INJECT_SCRIPTS__ = (scripts) => {
    if (!Array.isArray(scripts)) return;
    for (const script of scripts) {
      if (script?.type === 'inline' && script.content && script.content.length > 0) {
        try {
          const run = new Function(script.content);
          run();
        } catch (err) {
          console.error('[MCP] Failed to run injected script:', err);
        }
      }
    }
  };
})();
