// Deno Deploy Proxy
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

serve(async (req: Request) => {
  // 1. Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    
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

    // 4. Headers
    const newHeaders = new Headers(req.headers);
    newHeaders.set("Host", "generativelanguage.googleapis.com");
    newHeaders.delete("x-forwarded-for");
    
    // 5. Retry Logic
    let response;
    let attempt = 0;
    let bodyText = null;
    
    if (req.method !== "GET" && req.method !== "HEAD") {
      bodyText = await req.text();
    }

    while (attempt < 3) {
      attempt++;
      try {
        console.log(`Attempt ${attempt} to ${targetUrl}`);
        response = await fetch(targetUrl, {
          method: req.method,
          headers: newHeaders,
          body: bodyText,
        });

        if (response.status === 503 || response.status === 429) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        break;
      } catch (e) {
        console.error("Fetch error:", e);
        if (attempt === 3) throw e;
      }
    }

    if (!response) throw new Error("Failed to connect to Google");

    // 6. Streaming with Keep-Alive
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Process in background
    (async () => {
      try {
        const reader = response.body?.getReader();
        if (!reader) {
            await writer.close();
            return;
        }

        // Initial Start Signal
        await writer.write(encoder.encode(": start\n\n"));

        // Heartbeat Loop
        const heartbeat = setInterval(() => {
          try {
            writer.write(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
          } catch (_) {
            clearInterval(heartbeat);
          }
        }, 15000);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        
        clearInterval(heartbeat);
        await writer.close();
      } catch (e) {
        console.error("Stream failed", e);
        try { await writer.close(); } catch (_) {}
      }
    })();

    // 7. Response Headers
    const responseHeaders = new Headers(response.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
    responseHeaders.set("Content-Type", "text/event-stream");
    
    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
});
