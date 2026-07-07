const MALL_ID = import.meta.env.VITE_CAFE24_MALL_ID
const CLIENT_ID = import.meta.env.VITE_CAFE24_CLIENT_ID
const REDIRECT_URI = `${window.location.origin}/auth/cafe24/callback`

export function getCafe24AuthUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'mall.read_order,mall.write_order,mall.read_shipping,mall.write_shipping',
  })
  return `https://${MALL_ID}.cafe24api.com/api/v2/oauth/authorize?${params}`
}

export async function exchangeCodeForTokens(code: string) {
  const res = await fetch(`/api/cafe24/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: REDIRECT_URI }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
