const MCP_URL = 'https://api.bitrefill.com/mcp';

export async function bitrefillTool(name, args) {
  const key = process.env.BITREFILL_API_KEY?.trim();
  if (!key) {
    throw new Error('BITREFILL_API_KEY is not set. The Bitrefill MCP is https://api.bitrefill.com/mcp.');
  }
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Bitrefill MCP failed with HTTP ${response.status}`);
  const message = parseMcp(raw);
  if (message.error) throw new Error(message.error.message || 'Bitrefill MCP rejected the call');
  const text = (message.result?.content || []).map((item) => item.text || '').join('\n');
  if (message.result?.isError) throw new Error(text.slice(0, 300) || 'Bitrefill MCP tool failed');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseMcp(raw) {
  const line = raw.split('\n').find((item) => item.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : raw);
}
