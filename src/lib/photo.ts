// 배송원 앱에서 찍은 사진을 업로드 전에 축소 — 원본 그대로 올리면 느리고 용량도 큼
export function compressImage(file: File): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const maxW = 800
      const scale = Math.min(1, maxW / img.width)
      canvas.width = img.width * scale
      canvas.height = img.height * scale
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(blob => resolve(blob!), 'image/jpeg', 0.7)
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

// 사진 저장 경로: 업로드날짜(KST, YYYYMMDD) / 담당자ID / 파일명 — 스토리지에서 날짜→담당자 순으로
// 찾아볼 수 있게 함. 스토리지 경로는 한글 같은 비ASCII 문자를 못 써서 담당자ID는 이메일 앞부분
// (없으면 계정 id)을 쓰고, 허용 안 되는 문자는 _로 바꿈(2026-10-15)
export function photoStoragePath(user: { id: string; email?: string | null }, fileBase: string) {
  const ymd = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
  const who = (user.email?.split('@')[0] || user.id).replace(/[^A-Za-z0-9._-]/g, '_')
  const base = fileBase.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${ymd}/${who}/${base}_${Date.now()}.jpg`
}
