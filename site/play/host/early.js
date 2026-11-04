// Loaded first by index.html (a classic script, in <head>).
// Wake the browser's GPU process while the page's modules load: the first
// requestAdapter takes ~0.3 s; main.js asks again and then gets it at once.
try { navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => {}); } catch (e) { /* compat.js reports it */ }
