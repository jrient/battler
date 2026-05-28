// AgentClash API helper — minimal fetch wrapper
// Usage:
//   const data = await api.get('/api/matches');
//   const res = await api.post('/api/commander/code', { code, submittedBy });
// Cookie-based auth (web session) is sent automatically. For Bearer use api.withKey(key).

(function () {
  class ApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  async function request(method, path, body, extraHeaders) {
    const headers = { "accept": "application/json", ...(extraHeaders || {}) };
    const init = { method, headers, credentials: "same-origin" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    let payload = null;
    const text = await res.text();
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!res.ok) {
      const msg = (payload && payload.error) || res.statusText || "request failed";
      throw new ApiError(msg, res.status, payload);
    }
    return payload;
  }

  const api = {
    get: (path, headers) => request("GET", path, undefined, headers),
    post: (path, body, headers) => request("POST", path, body ?? {}, headers),
    del: (path, headers) => request("DELETE", path, undefined, headers),
    withKey(key) {
      const auth = { authorization: `Bearer ${key}` };
      return {
        get: (path) => request("GET", path, undefined, auth),
        post: (path, body) => request("POST", path, body ?? {}, auth),
        del: (path) => request("DELETE", path, undefined, auth),
      };
    },
    ApiError,
  };

  window.api = api;
})();
