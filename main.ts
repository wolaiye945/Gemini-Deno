import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const generateId = () => Math.random().toString(36).substring(2, 6);

serve(async (req: Request) => {
  const reqId = generateId();
  
  // 1. Fast CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    
    // 2. Target Setup
    let targetPath = url.pathname;
    if (targetPath.startsWith("/models")) targetPath = "/v1beta" + targetPath;
    
    const targetUrl = new URL(targetPath + url.search, "https://generativelanguage.googleapis.com");
    if (!targetUrl.searchParams.has("alt")) targetUrl.searchParams.set("alt", "sse");

    const newHeaders = new Headers(req.headers);
    newHeaders.set("Host", "generativelanguage.googleapis.com");
    newHeaders.delete("x-forwarded-for");

    // 3. Connect Upstream
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: newHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : null,
    });

    if (!response.ok) {
      return new Response(await response.text(), { status: response.status, headers: CORS_HEADERS });
    }

    // 4. Optimized Stream Setup
    // We use a larger highWaterMark (buffer) to prevent backpressure slowdowns
    const { readable, writable } = new TransformStream(undefined, { highWaterMark: 16384 });
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // 5. Smart State Management (No heavy locks)
    let lastWriteTime = Date.now();
    let isWriting = false;
    let isFinished = false;

    // Helper: Raw fast write
    const fastWrite = async (data: Uint8Array) => {
      if (isFinished) return;
      try {
        isWriting = true;
        await writer.ready;
        await writer.write(data);
        lastWriteTime = Date.now();
      } catch (e) {
        // If client disconnects, we stop silently
        isFinished = true; 
      } finally {
        isWriting = false;
      }
    };

    // 6. Background Heartbeat (Passive)
    // Only runs if the stream is SILENT for > 10 seconds.
    // This consumes 0 resources during active generation.
    (async () => {
      while (!isFinished) {
        await new Promise(r => setTimeout(r, 2000)); // Check every 2s
        
        if (isFinished) break;

        // Only send heartbeat if idle for 10s AND not currently writing data
        if (!isWriting && (Date.now() - lastWriteTime > 10000)) {
           // console.log(`[${reqId}] ❤️ Sending Keep-Alive`);
           await fastWrite(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
        }
      }
    })();

    // 7. Main Data Loop (High Priority)
    (async () => {
      try {
        const reader = response.body?.getReader();
        if (!reader) {
          isFinished = true;
          await writer.close();
          return;
        }

        // Send start signal
        await fastWrite(encoder.encode(": start\n\n"));

        while (true) {
          const { done, value } = await reader.read();
          
          if (done || isFinished) break;

          // DIRECT WRITE - No waiting for locks
          await fastWrite(value);
        }

      } catch (e) {
        console.error(`[${reqId}] Stream Error:`, e);
        if (!isFinished) {
          await fastWrite(encoder.encode(`data: {"error": "Proxy Error"}\n\n`));
        }
      } finally {
        isFinished = true;
        try { await writer.close(); } catch (_) {}
      }
    })();

    // 8. Response
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
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
