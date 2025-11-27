import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

serve(async (req: Request) => {
  // 1. Fast CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    
    // 2. Build Upstream URL
    let targetPath = url.pathname;
    if (targetPath.startsWith("/models")) targetPath = "/v1beta" + targetPath;
    
    const targetUrl = new URL(targetPath + url.search, "https://generativelanguage.googleapis.com");
    if (!targetUrl.searchParams.has("alt")) targetUrl.searchParams.set("alt", "sse");

    const newHeaders = new Headers(req.headers);
    newHeaders.set("Host", "generativelanguage.googleapis.com");
    newHeaders.delete("x-forwarded-for");

    // 3. Fetch from Google
    const googleResponse = await fetch(targetUrl, {
      method: req.method,
      headers: newHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : null,
    });

    // 4. Handle Errors Immediately
    if (!googleResponse.ok) {
      return new Response(googleResponse.body, {
        status: googleResponse.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    // 5. Native Stream Transformation
    // This is the magic fix. We don't loop manually. We define a transformer.
    let started = false;
    const encoder = new TextEncoder();

    const transformer = new TransformStream({
      start(controller) {
        // Send SSE init immediately
        controller.enqueue(encoder.encode(": start\n\n"));
        started = true;
      },
      transform(chunk, controller) {
        // Pass the raw Google chunk directly to the client
        // Zero processing, zero await lag
        controller.enqueue(chunk);
      },
      flush(controller) {
        // Optional: Send a final newline if needed, usually not required for SSE
      }
    });

    // 6. Construct the Pipeline
    // googleResponse.body -> transformer -> Client
    // We use the native .body property which is highly optimized
    const stream = googleResponse.body?.pipeThrough(transformer);

    // 7. Return the Response
    const responseHeaders = new Headers(googleResponse.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
    // Force SSE headers
    responseHeaders.set("Content-Type", "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache");
    responseHeaders.set("Connection", "keep-alive");
    responseHeaders.delete("Content-Length"); // Ensure chunked encoding

    return new Response(stream, {
      status: googleResponse.status,
      headers: responseHeaders,
    });

  } catch (err: any) {
    console.error("Proxy Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
});
