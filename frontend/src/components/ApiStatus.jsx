import React, { useEffect, useState } from 'react'

export default function ApiStatus() {
  const [status, setStatus] = useState('checking')
  useEffect(() => {
    fetch('/api/health').then(r=>r.json()).then(()=>setStatus('online')).catch(()=>setStatus('mock'))
    fetch('/health').then(r=>r.json()).then(()=>setStatus('online')).catch(()=>setStatus('mock'))
  }, [])
  return (
    <div style={{fontSize:11, padding:'4px 8px', borderRadius:4, background: status==='online' ? '#065f46' : '#78350f', color: status==='online' ? '#6ee7b7' : '#fcd34d', display:'inline-block'}}>
      API: {status === 'online' ? 'Connected to Go Gateway' : status === 'mock' ? 'Mock Mode (Gateway offline, using fallback)' : 'Checking...'}
    </div>
  )
}
