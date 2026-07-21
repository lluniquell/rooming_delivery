import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  (process.env.VITE_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const token = (req.headers.authorization ?? '').replace('Bearer ', '')
  if (!token) return res.status(401).json({ message: '인증이 필요합니다.' })

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return res.status(401).json({ message: '인증에 실패했습니다.' })

  const { data: caller } = await supabase.from('drivers').select('is_superadmin').eq('id', user.id).single()
  if (!caller?.is_superadmin) return res.status(403).json({ message: '계정 관리 권한이 없습니다.' })

  const { name, email, password, permissions } = req.body ?? {}
  if (!name || !email || !password) {
    return res.status(400).json({ message: '이름, 이메일, 비밀번호를 모두 입력하세요.' })
  }

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createError || !created.user) {
    return res.status(400).json({ message: createError?.message ?? '계정 생성 실패' })
  }

  const { error: insertError } = await supabase.from('drivers').insert({
    id: created.user.id,
    name,
    email,
    role: 'admin',
    is_active: true,
    is_superadmin: false,
    permissions: Array.isArray(permissions) ? permissions : [],
  })

  if (insertError) {
    await supabase.auth.admin.deleteUser(created.user.id)
    return res.status(400).json({ message: insertError.message })
  }

  res.status(200).json({ ok: true })
}
