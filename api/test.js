export default async function handler(request) {
  return new Response(JSON.stringify({ ok: true, runtime: typeof Response }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
