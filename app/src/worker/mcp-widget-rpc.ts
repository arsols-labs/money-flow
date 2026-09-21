/**
 * Shared MCP Apps iframe RPC. Parent-only, origin-pinned after the first
 * parent message, unguessable request IDs, and structured result checks.
 */
export const MCP_WIDGET_RPC_SCRIPT = `
      const pendingRequests = new Map();
      let trustedParentOrigin = null;

      function parentTargetOrigin() {
        if (trustedParentOrigin) return trustedParentOrigin;
        try {
          if (document.referrer) return new URL(document.referrer).origin;
        } catch {}
        return '*';
      }

      function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
      }

      function acceptParentMessage(event) {
        if (event.source !== window.parent) return null;
        if (trustedParentOrigin && event.origin !== trustedParentOrigin) return null;
        const msg = event.data;
        if (!isPlainObject(msg) || msg.jsonrpc !== '2.0') return null;
        if (!trustedParentOrigin) trustedParentOrigin = event.origin;
        return msg;
      }

      function sendRequest(method, params) {
        const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + '-' + Math.random();
        return new Promise((resolve, reject) => {
          pendingRequests.set(id, { resolve, reject });
          window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, parentTargetOrigin());
          setTimeout(() => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id);
              reject(new Error('Timeout waiting for host response'));
            }
          }, 15000);
        });
      }

      function sendNotification(method, params) {
        window.parent.postMessage({ jsonrpc: '2.0', method, params }, parentTargetOrigin());
      }

      function acceptRpcResult(result) {
        if (result === undefined || result === null) return result;
        if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
          return result;
        }
        if (!isPlainObject(result)) return null;
        return result;
      }
`;
