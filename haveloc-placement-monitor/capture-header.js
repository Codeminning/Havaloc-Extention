// ============================================================================
// capture-header.js
// Runs in the PAGE's own JS world (not the isolated extension world), so it
// can see the same XHR/fetch calls Haveloc's own frontend makes.
// ============================================================================

(function () {
  const TARGETS = ["studentJobSubViews", "job", "app", "api"];
  const AUTH_HEADER_NAMES = ["api-key", "authorization", "x-api-key", "token", "x-auth-token", "authtoken"];
  const EVENT_CAPTURE = "__haveloc_monitor_capture";
  const EVENT_ENDPOINT = "__haveloc_monitor_endpoint";
  const EVENT_DATA = "__haveloc_monitor_data";

  function announceApiKey(apiKey) {
    if (!apiKey) return;
    window.dispatchEvent(
      new CustomEvent(EVENT_CAPTURE, { detail: { apiKey } })
    );
  }

  function isAuthHeader(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    return AUTH_HEADER_NAMES.includes(lower);
  }

  function matchesTarget(url) {
    if (!url) return true;
    return TARGETS.some((target) => url.includes(target));
  }

  // Check localStorage & sessionStorage on page load in case token is persisted
  try {
    const keysToCheck = ["api-key", "apiKey", "token", "authToken", "authorization", "x-api-key"];
    for (const k of keysToCheck) {
      const val = localStorage.getItem(k) || sessionStorage.getItem(k);
      if (val && typeof val === "string" && val.trim()) {
        announceApiKey(val.trim());
        break;
      }
    }
  } catch (e) {
    /* ignore storage access errors */
  }

  // Intercept XHR
  const OriginalXHR = window.XMLHttpRequest;
  const originalOpen = OriginalXHR.prototype.open;
  const originalSetHeader = OriginalXHR.prototype.setRequestHeader;
  const originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (method, url, ...rest) {
    try {
      this.__haveloc_url = String(url);
      this.__haveloc_headers = {};
    } catch (e) {
      /* ignore */
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXHR.prototype.setRequestHeader = function (name, value) {
    try {
      if (this.__haveloc_headers) {
        this.__haveloc_headers[name] = value;
      }
      if (isAuthHeader(name)) {
        announceApiKey(value);
      }
    } catch (e) {
      /* never let observation break the real request */
    }
    return originalSetHeader.call(this, name, value);
  };

  OriginalXHR.prototype.send = function (...args) {
    try {
      if (this.__haveloc_url && this.__haveloc_url.includes("studentJobSubViews")) {
        // Announce exact URL and headers used by the page
        window.dispatchEvent(
          new CustomEvent(EVENT_ENDPOINT, {
            detail: {
              url: this.__haveloc_url,
              headers: this.__haveloc_headers || {},
            },
          })
        );

        // Intercept real response from the page
        this.addEventListener("load", function () {
          if (this.status === 200 && this.responseText) {
            try {
              const text = this.responseText.trim();
              if (text.startsWith("{") || text.startsWith("[")) {
                const data = JSON.parse(text);
                window.dispatchEvent(
                  new CustomEvent(EVENT_DATA, {
                    detail: {
                      url: this.__haveloc_url,
                      headers: this.__haveloc_headers,
                      data: data,
                    },
                  })
                );
              }
            } catch (err) {
              /* ignore parse errors */
            }
          }
        });
      }
    } catch (e) {
      /* ignore */
    }
    return originalSend.apply(this, args);
  };

  // Intercept Fetch
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (matchesTarget(url) && init && init.headers) {
          if (init.headers instanceof Headers) {
            for (const h of AUTH_HEADER_NAMES) {
              const val = init.headers.get(h);
              if (val) announceApiKey(val);
            }
          } else if (typeof init.headers === "object") {
            for (const [key, val] of Object.entries(init.headers)) {
              if (isAuthHeader(key) && val) {
                announceApiKey(val);
              }
            }
          }
        }
      } catch (e) {
        /* never let observation break the real request */
      }

      const response = await originalFetch.apply(this, arguments);

      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("studentJobSubViews") && response && response.ok) {
          const clone = response.clone();
          clone.text().then((text) => {
            const trimmed = text.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
              const data = JSON.parse(trimmed);
              window.dispatchEvent(
                new CustomEvent(EVENT_DATA, {
                  detail: { url, data },
                })
              );
            }
          }).catch(() => {});
        }
      } catch (e) {
        /* ignore */
      }

      return response;
    };
  }
})();
