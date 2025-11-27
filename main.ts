import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

serve(async (req: Request) => {
  // 1. CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    let targetPath = url.pathname;
    if (targetPath.startsWith("/models")) targetPath = "/v1beta" + targetPath;

    const targetUrl = new URL(targetPath + url.search, "https://generativelanguage.googleapis.com");
    if (!targetUrl.searchParams.has("alt")) targetUrl.searchParams.set("alt", "sse");

    const newHeaders = new Headers(req.headers);
    newHeaders.set("Host", "generativelanguage.googleapis.com");
    newHeaders.delete("x-forwarded-for");

    // 2. Fetch from Google
    const googleResponse = await fetch(targetUrl, {
      method: req.method,
      headers: newHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : null,
    });

    if (!googleResponse.ok) {
      return new Response(googleResponse.body, {
        status: googleResponse.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const reader = googleResponse.body?.getReader();
    if (!reader) throw new Error("No body from Google");

    const encoder = new TextEncoder();

    // 3. Hybrid Stream (Speed + Stability)
    const stream = new ReadableStream({
      async start(controller) {
        // Send Initial Start
        controller.enqueue(encoder.encode(": start\n\n"));

        // 4. heartbeat Loop
        // This runs independently. It detects if 'lastRead' is old.
        let lastRead = Date.now();
        let closed = false;
        
        const hbInterval = setInterval(() => {
            if (closed) {
                clearInterval(hbInterval);
                return;
            }
            // If we haven't read data in 9 seconds, send a heartbeat
            if (Date.now() - lastRead > 9000) {
                try {
                    controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
                } catch (e) {
                    // Controller might be closed, cleanup
                    clearInterval(hbInterval);
                }
            }
        }, 3000); // Check every 3 seconds

        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              closed = true;
              clearInterval(hbInterval);
              controller.close();
              break;
            }

            // Update activity timestamp
            lastRead = Date.now();

            // Pass data through immediately (Fast)
            controller.enqueue(value);
          }
        } catch (err) {
          closed = true;
          clearInterval(hbInterval);
          controller.error(err);
        }
      },
      cancel() {
        // If client disconnects, kill the upstream reader
        reader.cancel();
      }
    });

    // 5. Return Response
    const responseHeaders = new Headers(googleResponse.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
    responseHeaders.set("Content-Type", "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    responseHeaders.set("Connection", "keep-alive");

    return new Response(stream, {
      status: googleResponse.status,
      headers: responseHeaders,
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
