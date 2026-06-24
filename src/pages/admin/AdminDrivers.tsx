import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Driver } from '../../types'

export default function AdminDrivers() {
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState('')

  async function load() {
    const { data } = await supabase.from('drivers').select('*').order('created_at')
    setDrivers(data ?? [])
  }

  useEffect(() => { load() }, [])

  async function addDriver(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setMessage('')

    const res = await fetch('/api/admin/create-driver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    })

    if (res.ok) {
      setMessage('배송원 추가 완료!')
      setName(''); setEmail(''); setPassword('')
      load()
    } else {
      const err = await res.json()
      setMessage(`오류: ${err.message}`)
    }
    setAdding(false)
  }

  async function toggleActive(driver: Driver) {
    await supabase.from('drivers').update({ is_active: !driver.is_active }).eq('id', driver.id)
    load()
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold text-gray-800 mb-6">배송원 관리</h2>

      <div className="bg-white rounded-xl border p-6 mb-6">
        <h3 className="font-medium text-gray-800 mb-4">배송원 추가</h3>
        <form onSubmit={addDriver} className="flex gap-3 flex-wrap">
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
          <button
            type="submit"
            disabled={adding}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {adding ? '추가 중...' : '추가'}
          </button>
        </form>
        {message && <p className="mt-2 text-sm text-gray-600">{message}</p>}
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">이름</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">이메일</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">상태</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {drivers.filter(d => d.role === 'driver').map(d => (
              <tr key={d.id} className="border-b last:border-0">
                <td className="px-4 py-3">{d.name}</td>
                <td className="px-4 py-3 text-gray-500">{d.email}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${d.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {d.is_active ? '활성' : '비활성'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => toggleActive(d)}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    {d.is_active ? '비활성화' : '활성화'}
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
