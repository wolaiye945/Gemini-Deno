import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Helper to safely write to the stream
async function safeWrite(writer: WritableStreamDefaultWriter, data: Uint8Array) {
  try {
    await writer.ready; // Wait for backpressure
    await writer.write(data);
    return true;
  } catch (e) {
    // If the client disconnected, this will throw BadResource or BrokenPipe
    // We return false to signal "stop processing"
    return false;
  }
}

serve(async (req: Request) => {
  // 1. Handle CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    
    // 2. Path Handling
    let targetPath = url.pathname;
    if (targetPath.startsWith("/models")) {
      targetPath = "/v1beta" + targetPath;
    }
    
    const targetUrl = new URL(targetPath + url.search, "https://generativelanguage.googleapis.com");
    
    // 3. Force SSE
    if (!targetUrl.searchParams.has("alt")) {
      targetUrl.searchParams.set("alt", "sse");
    }

    // 4. Prepare Headers
    const newHeaders = new Headers(req.headers);
    newHeaders.set("Host", "generativelanguage.googleapis.com");
    newHeaders.delete("x-forwarded-for"); // Privacy

    // 5. Read Body (Buffer it for potential retries)
    let bodyText: string | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      bodyText = await req.text();
    }

    // 6. Fetch from Google with Retry Logic
    let response;
    let attempt = 0;

    while (attempt < 3) {
      attempt++;
      try {
        // console.log(`Attempt ${attempt} to ${targetUrl}`);
        response = await fetch(targetUrl, {
          method: req.method,
          headers: newHeaders,
          body: bodyText,
        });

        // Retry on 503 (Overload) or 429 (Rate Limit)
        if (response.status === 503 || response.status === 429) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        
        break;
      } catch (e) {
        console.error(`Fetch error attempt ${attempt}:`, e);
        if (attempt === 3) throw e;
      }
    }

    if (!response) throw new Error("Failed to connect to Google upstream.");

    // 7. Create the Stream
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // 8. Process the stream in the background
    // We do NOT await this, so the Response returns immediately
    (async () => {
      let heartbeatInterval;
      try {
        const reader = response.body?.getReader();
        if (!reader) {
          await writer.close();
          return;
        }

        // Send initial start signal
        if (!await safeWrite(writer, encoder.encode(": start\n\n"))) return;

        // Start Heartbeat (Keep-Alive)
        heartbeatInterval = setInterval(async () => {
          const success = await safeWrite(writer, encoder.encode(`: keep-alive ${Date.now()}\n\n`));
          if (!success) clearInterval(heartbeatInterval);
        }, 15000);

        // Pump data chunks
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          // If write fails (client disconnected), break loop
          if (!await safeWrite(writer, value)) break;
        }

      } catch (e) {
        // If an error occurs during streaming (e.g. Google cuts connection)
        console.error("Streaming interrupted:", e);
        // Try to send an error event to the client
        await safeWrite(writer, encoder.encode(`data: {"error": "Proxy Stream Interrupted: ${String(e)}"}\n\n`));
      } finally {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        try { await writer.close(); } catch (_) { /* Ignore close errors */ }
      }
    })();

    // 9. Return the Response immediately
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
    // Global Error Handler
    console.error("Global Handler Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
});
