const MODEL = 'claude-haiku-4-5-20251001';

export async function classifyEmails(emails) {
  if (emails.length === 0) return [];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      tools: [
        {
          name: 'classify_emails',
          description: 'Vráti klasifikáciu pre každý email v poli.',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer' },
                    category: { type: 'string', enum: ['ponuka', 'ostatne'] },
                    summary: {
                      type: 'string',
                      description: 'Len ak category=ponuka: 1 veta po slovensky/česky, kto a čo ponúka.',
                    },
                  },
                  required: ['index', 'category'],
                },
              },
            },
            required: ['results'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'classify_emails' },
      messages: [
        {
          role: 'user',
          content:
            'Zaraď každý z nasledujúcich emailov do kategórie "ponuka" (obchodná/predajná ponuka, ' +
            'reklama, akcia, cenová ponuka od dodávateľa) alebo "ostatne" (osobná komunikácia, ' +
            'faktúry, notifikácie, pracovné maily a pod). Pre "ponuka" pridaj krátke jednovetové ' +
            'zhrnutie (kto a čo ponúka).\n\n' +
            JSON.stringify(
              emails.map((e, i) => ({
                index: i,
                from: e.from,
                subject: e.subject,
                preview: e.preview.slice(0, 400),
              }))
            ),
        },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API failed: ${JSON.stringify(data)}`);

  const toolUse = data.content?.find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error(`Claude did not return classification: ${JSON.stringify(data)}`);

  return toolUse.input.results || [];
}
