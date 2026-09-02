export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Melichar Viber webhook is running.', { status: 200 });
    }

    let body = null;
    try {
      body = await request.json();
    } catch {
      // ignore malformed payloads
    }

    if (body) {
      // Visible via `wrangler tail` — used once during setup to read your
      // Viber user id (body.sender.id or body.user.id) for VIBER_RECEIVER_ID.
      console.log('Viber webhook event:', JSON.stringify(body));
    }

    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
