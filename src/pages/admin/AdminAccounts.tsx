import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Driver, Permission } from '../../types'
import { ASSIGNABLE_PERMISSIONS, isDriverAccount } from './AdminLayout'

export default function AdminAccounts() {
  const [accounts, setAccounts] = useState<Driver[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // 기본값 '관리자'(전체 메뉴) — 아무것도 안 건드리면 전체 권한, 좁히고 싶으면 직접 조정
  const [selected, setSelected] = useState<Permission[]>(['admin'])
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState('')

  async function load() {
    const { data } = await supabase
      .from('drivers')
      .select('*')
      .eq('is_superadmin', false)
      .order('created_at')
    setAccounts(data ?? [])
  }

  useEffect(() => { load() }, [])

  // '배송팀'(모바일 앱)을 고르면 다른 메뉴 권한은 무의미하므로 비움, 반대로 메뉴 권한을 고르면 배송팀 해제
  function toggleSelection(key: Permission) {
    setSelected(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key)
      if (key === 'driver') return ['driver']
      return [...prev.filter(k => k !== 'driver'), key]
    })
  }

  const isDriver = selected.includes('driver')

  async function addAccount(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setMessage('')

    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin/create-account', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ name, email, password, permissions: selected }),
    })

    if (res.ok) {
      setMessage('계정 추가 완료!')
      setName(''); setEmail(''); setPassword(''); setSelected(['admin'])
      load()
    } else {
      const err = await res.json()
      setMessage(`오류: ${err.message}`)
    }
    setAdding(false)
  }

  async function updatePermissions(account: Driver, key: Permission) {
    const current = account.permissions ?? []
    let next: Permission[]
    if (current.includes(key)) {
      next = current.filter(p => p !== key)
    } else if (key === 'driver') {
      next = ['driver']
    } else {
      next = [...current.filter(p => p !== 'driver'), key]
    }
    const { data, error } = await supabase.from('drivers').update({ permissions: next }).eq('id', account.id).select()
    // RLS 등으로 실제로는 반영이 안 됐는데 에러도 안 나는 경우(0건 반영)를 잡아냄
    if (error || !data?.length) {
      alert(`권한 변경 실패: ${error?.message ?? '반영된 행이 없습니다 (권한 문제일 수 있음)'}`)
      return
    }
    load()
  }

  async function toggleActive(account: Driver) {
    const { data, error } = await supabase.from('drivers').update({ is_active: !account.is_active }).eq('id', account.id).select()
    if (error || !data?.length) {
      alert(`상태 변경 실패: ${error?.message ?? '반영된 행이 없습니다 (권한 문제일 수 있음)'}`)
      return
    }
    load()
  }

  async function resetPassword(account: Driver) {
    const newPassword = prompt(`${account.name}(${account.email})의 새 비밀번호를 입력하세요 (6자 이상)`)
    if (!newPassword) return
    if (newPassword.length < 6) { alert('비밀번호는 6자 이상이어야 합니다.'); return }

    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin/create-account?action=reset-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ driver_id: account.id, new_password: newPassword }),
    })
    if (res.ok) {
      alert('비밀번호가 변경되었습니다.')
    } else {
      const err = await res.json()
      alert(`비밀번호 변경 실패: ${err.message}`)
    }
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-gray-800 mb-6">계정 관리</h2>

      <div className="bg-white rounded-xl border p-6 mb-6">
        <h3 className="font-medium text-gray-800 mb-4">계정 추가</h3>
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
            <p className="text-xs font-medium text-gray-500 mb-2">권한 (메뉴 접근 또는 배송팀 모바일 앱)</p>
            <div className="flex flex-wrap gap-2">
              {ASSIGNABLE_PERMISSIONS.map(g => (
                <button
                  type="button"
                  key={g.key}
                  onClick={() => toggleSelection(g.key)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    selected.includes(g.key)
                      ? g.key === 'driver' ? 'bg-teal-600 text-white border-teal-600' : 'bg-blue-600 text-white border-blue-600'
                      : 'text-gray-600 border-gray-300 hover:border-blue-400'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-gray-400 mb-2">
            {name || '이 계정'}을(를) <b className={isDriver ? 'text-teal-600' : 'text-indigo-600'}>{isDriver ? '배송팀(모바일)' : '관리자'}</b>로 추가합니다
            {!isDriver && selected.length > 0 && ` (권한: ${selected.map(k => ASSIGNABLE_PERMISSIONS.find(o => o.key === k)?.label).join(', ')})`}
          </p>
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
              <tr><td colSpan={5} className="text-center py-12 text-gray-400">등록된 계정이 없습니다.</td></tr>
            )}
            {accounts.map(a => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-medium text-gray-800">{a.name}</td>
                <td className="px-4 py-3 text-gray-500">{a.email}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {ASSIGNABLE_PERMISSIONS.map(g => (
                      <button
                        key={g.key}
                        onClick={() => updatePermissions(a, g.key)}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                          a.permissions?.includes(g.key)
                            ? g.key === 'driver'
                              ? 'bg-teal-100 text-teal-700 border-teal-200'
                              : 'bg-blue-100 text-blue-700 border-blue-200'
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
                  {isDriverAccount(a) && <span className="ml-1 text-[10px] text-teal-500">모바일</span>}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button
                    onClick={() => resetPassword(a)}
                    className="text-xs text-gray-400 hover:text-indigo-500 mr-3"
                  >
                    비밀번호 변경
                  </button>
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
