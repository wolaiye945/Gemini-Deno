import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const generateId = () => Math.random().toString(36).substring(2, 6);

// --- MUTEX LOCK ---
// Prevents Heartbeat and Data from writing simultaneously
class StreamLock {
  private _lock: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T | null> {
    const currentLock = this._lock;
    let release: () => void;
    
    // Create a new lock promise
    this._lock = new Promise((resolve) => { release = resolve; });

    // Wait for previous task to finish
    await currentLock;

    try {
      return await task();
    } finally {
      // Release the lock for the next task
      release!();
    }
  }
}

serve(async (req: Request) => {
  const reqId = generateId();
  
  // 1. CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    // console.log(`[${reqId}] 🚀 Request: ${req.method} ${url.pathname}`);

    // 2. Path & Headers
    let targetPath = url.pathname;
    if (targetPath.startsWith("/models")) targetPath = "/v1beta" + targetPath;
    
    const targetUrl = new URL(targetPath + url.search, "https://generativelanguage.googleapis.com");
    if (!targetUrl.searchParams.has("alt")) targetUrl.searchParams.set("alt", "sse");

    const newHeaders = new Headers(req.headers);
    newHeaders.set("Host", "generativelanguage.googleapis.com");
    newHeaders.delete("x-forwarded-for");

    // 3. Fetch Google
    // console.log(`[${reqId}] ⏳ Connecting upstream...`);
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: newHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : null,
    });

    if (!response.ok) {
      console.error(`[${reqId}] ❌ Google Error: ${response.status}`);
      return new Response(await response.text(), { status: response.status, headers: CORS_HEADERS });
    }

    // 4. Setup Stream & Lock
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const lock = new StreamLock();

    // Helper: Locked Safe Write
    const safeWrite = async (data: Uint8Array, context: string) => {
      // If client already disconnected (AbortSignal), don't bother writing
      if (req.signal.aborted) return false;

      return await lock.run(async () => {
        try {
          await writer.ready;
          await writer.write(data);
          return true;
        } catch (e: any) {
          // Ignore standard disconnect errors to keep logs clean
          if (e.message.includes("response already completed") || 
              e.message.includes("BadResource") || 
              e.message.includes("Broken pipe")) {
            // console.log(`[${reqId}] ℹ️ Client disconnected (${context})`);
          } else {
            console.warn(`[${reqId}] ⚠️ Write Error (${context}): ${e.message}`);
          }
          return false;
        }
      });
    };

    // 5. Background Process
    (async () => {
      const reader = response.body?.getReader();
      if (!reader) {
        await writer.close();
        return;
      }

      // Heartbeat Interval
      const heartbeat = setInterval(async () => {
        if (req.signal.aborted) {
           clearInterval(heartbeat);
           return;
        }
        // Keep-alive comment
        const success = await safeWrite(encoder.encode(`: keep-alive ${Date.now()}\n\n`), "Heartbeat");
        if (!success) clearInterval(heartbeat);
      }, 8000); // 8 seconds (faster than typical 10-15s timeouts)

      try {
        // Send Start
        if (!await safeWrite(encoder.encode(": start\n\n"), "Init")) return;

        while (true) {
          if (req.signal.aborted) break; // Stop if client leaves

          const { done, value } = await reader.read();
          if (done) break;

          // Write Data
          const success = await safeWrite(value, "Data");
          if (!success) break;
        }
      } catch (e) {
        console.error(`[${reqId}] Stream Loop Error:`, e);
      } finally {
        clearInterval(heartbeat);
        try { await writer.close(); } catch (_) {}
        // console.log(`[${reqId}] 🔒 Done.`);
      }
    })();

    // 6. Return Response
    const responseHeaders = new Headers(response.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
    responseHeaders.set("Content-Type", "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    responseHeaders.set("Connection", "keep-alive");

    return new Response(readable, {
      status: response.status,
      headers: responseHeaders,
    });

  } catch (err: any) {
    console.error(`[${reqId}] Fatal:`, err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
