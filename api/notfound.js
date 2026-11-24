export const config = { runtime: "edge" };

// ponytail: bypass apple-touch-icon dan /favicon.ico (sama seperti worker: plain 404)
export default function handler() {
  return new Response("Not Found", { status: 404 });
}
