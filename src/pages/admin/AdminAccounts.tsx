import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Driver, Permission } from '../../types'
import { PERMISSION_GROUPS } from './AdminLayout'

export default function AdminAccounts() {
  const [accounts, setAccounts] = useState<Driver[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState('')

  async function load() {
    const { data } = await supabase
      .from('drivers')
      .select('*')
      .eq('role', 'admin')
      .eq('is_superadmin', false)
      .order('created_at')
    setAccounts(data ?? [])
  }

  useEffect(() => { load() }, [])

  function togglePerm(key: Permission) {
    setPermissions(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key])
  }

  async function addAccount(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setMessage('')

    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin/create-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ name, email, password, permissions }),
    })

    if (res.ok) {
      setMessage('계정 추가 완료!')
      setName(''); setEmail(''); setPassword(''); setPermissions([])
      load()
    } else {
      const err = await res.json()
      setMessage(`오류: ${err.message}`)
    }
    setAdding(false)
  }

  async function updatePermissions(account: Driver, key: Permission) {
    const next = account.permissions?.includes(key)
      ? account.permissions.filter(p => p !== key)
      : [...(account.permissions ?? []), key]
    await supabase.from('drivers').update({ permissions: next }).eq('id', account.id)
    load()
  }

  async function toggleActive(account: Driver) {
    await supabase.from('drivers').update({ is_active: !account.is_active }).eq('id', account.id)
    load()
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-gray-800 mb-6">계정 관리</h2>

      <div className="bg-white rounded-xl border p-6 mb-6">
        <h3 className="font-medium text-gray-800 mb-4">이용자 계정 추가</h3>
        <form onSubmit={addAccount}>
          <div className="flex gap-3 flex-wrap mb-4">
            <input
              placeholder="이름"
              value={name}
              onChange={e => setName(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-28"
              required
            />
            <input
              type="email"
              placeholder="이메일"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-40"
              required
            />
            <input
              type="password"
              placeholder="초기 비밀번호"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-32"
              required
            />
          </div>
          <div className="mb-4">
            <p className="text-xs font-medium text-gray-500 mb-2">메뉴 권한</p>
            <div className="flex flex-wrap gap-2">
              {PERMISSION_GROUPS.map(g => (
                <button
                  type="button"
                  key={g.key}
                  onClick={() => togglePerm(g.key)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    permissions.includes(g.key)
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'text-gray-600 border-gray-300 hover:border-blue-400'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="submit"
            disabled={adding}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {adding ? '추가 중...' : '계정 추가'}
          </button>
          {message && <p className="mt-2 text-sm text-gray-600">{message}</p>}
        </form>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">이름</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">이메일</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">권한</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">상태</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr><td colSpan={5} className="text-center py-12 text-gray-400">등록된 이용자 계정이 없습니다.</td></tr>
            )}
            {accounts.map(a => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-medium text-gray-800">{a.name}</td>
                <td className="px-4 py-3 text-gray-500">{a.email}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {PERMISSION_GROUPS.map(g => (
                      <button
                        key={g.key}
                        onClick={() => updatePermissions(a, g.key)}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                          a.permissions?.includes(g.key)
                            ? 'bg-blue-100 text-blue-700 border-blue-200'
                            : 'bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {g.label}
                      </button>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${a.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {a.is_active ? '활성' : '비활성'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => toggleActive(a)}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    {a.is_active ? '비활성화' : '활성화'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
