import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Helper: Generate short ID for logs
const generateId = () => Math.random().toString(36).substring(2, 6);

// Helper: Safe Write with Logging
async function safeWrite(
  writer: WritableStreamDefaultWriter, 
  data: Uint8Array, 
  reqId: string, 
  context: string
) {
  try {
    await writer.ready;
    await writer.write(data);
    return true;
  } catch (e: any) {
    // Log the EXACT error causing the break
    console.warn(`[${reqId}] ⚠️ Write failed during ${context}: ${e.name} - ${e.message}`);
    return false;
  }
}

serve(async (req: Request) => {
  const reqId = generateId();
  const startTime = Date.now();

  // 1. Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    console.log(`[${reqId}] 🚀 Incoming Request: ${req.method} ${url.pathname}`);

    // 2. Path Fix
    let targetPath = url.pathname;
    if (targetPath.startsWith("/models")) {
      targetPath = "/v1beta" + targetPath;
    }
    
    const targetUrl = new URL(targetPath + url.search, "https://generativelanguage.googleapis.com");
    
    // 3. Force SSE
    if (!targetUrl.searchParams.has("alt")) {
      targetUrl.searchParams.set("alt", "sse");
    }

    const newHeaders = new Headers(req.headers);
    newHeaders.set("Host", "generativelanguage.googleapis.com");
    newHeaders.delete("x-forwarded-for"); 
    
    // Log important headers from client
    // console.log(`[${reqId}] Client Headers:`, JSON.stringify(Object.fromEntries(newHeaders.entries())));

    // 4. Fetch from Google
    let bodyText: string | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      bodyText = await req.text();
    }

    console.log(`[${reqId}] ⏳ Connecting to Google...`);
    
    let response;
    try {
      response = await fetch(targetUrl, {
        method: req.method,
        headers: newHeaders,
        body: bodyText,
      });
    } catch (fetchErr) {
      console.error(`[${reqId}] ❌ Fetch Network Error:`, fetchErr);
      throw fetchErr;
    }

    console.log(`[${reqId}] ✅ Google Status: ${response.status} ${response.statusText}`);
    
    // Check if Google refused to stream
    const contentType = response.headers.get("content-type");
    console.log(`[${reqId}] Upstream Content-Type: ${contentType}`);

    if (!response.ok) {
       const errorText = await response.text();
       console.error(`[${reqId}] ❌ Google Error Body:`, errorText);
       return new Response(errorText, { status: response.status, headers: CORS_HEADERS });
    }

    // 5. Setup Pipeline
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // 6. Background Streaming Process
    (async () => {
      let heartbeatInterval;
      let chunkCount = 0;
      let totalBytes = 0;

      try {
        const reader = response.body?.getReader();
        if (!reader) {
          console.error(`[${reqId}] ❌ No response body from Google`);
          await writer.close();
          return;
        }

        // Initial Signal
        if (!await safeWrite(writer, encoder.encode(": start\n\n"), reqId, "Init")) return;

        // Heartbeat (every 10s to be safe)
        heartbeatInterval = setInterval(async () => {
          // console.log(`[${reqId}] 💓 Sending Heartbeat`);
          const success = await safeWrite(writer, encoder.encode(`: keep-alive ${Date.now()}\n\n`), reqId, "Heartbeat");
          if (!success) {
            console.warn(`[${reqId}] ⚠️ Heartbeat failed - clearing interval`);
            clearInterval(heartbeatInterval);
          }
        }, 10000);

        // Data Pump Loop
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            console.log(`[${reqId}] 🏁 Google Stream Complete. Total chunks: ${chunkCount}, Bytes: ${totalBytes}`);
            break;
          }

          chunkCount++;
          if (value) {
            totalBytes += value.byteLength;
            // Log large chunks or every 10th chunk to keep logs sane
            // if (chunkCount % 10 === 0 || value.byteLength > 1000) {
            //   console.log(`[${reqId}] 📦 Chunk #${chunkCount} size: ${value.byteLength}`);
            // }
          }

          // Write to client
          const success = await safeWrite(writer, value, reqId, "DataChunk");
          if (!success) {
            console.warn(`[${reqId}] ⚠️ Client disconnected during stream. Stopping.`);
            break;
          }
        }

      } catch (e: any) {
        console.error(`[${reqId}] ❌ Stream Loop Error:`, e);
        // Try to notify client of error
        await safeWrite(writer, encoder.encode(`data: {"error": "Proxy Stream Error: ${e.message}"}\n\n`), reqId, "ErrorNotification");
      } finally {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        console.log(`[${reqId}] 🔒 Closing Writer. Duration: ${(Date.now() - startTime) / 1000}s`);
        try { await writer.close(); } catch (_) {}
      }
    })();

    // 7. Return Response
    const responseHeaders = new Headers(response.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
    responseHeaders.set("Content-Type", "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    responseHeaders.set("Connection", "keep-alive");
    
    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (err: any) {
    console.error(`[${reqId}] ❌ Fatal Handler Error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
});
